const axios = require('axios');
const cheerio = require('cheerio');
const { Redis } = require('@upstash/redis');

// [DATABASE CONNECTION] Upstash Redis ချိတ်ဆက်ခြင်း
const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

module.exports = async (req, res) => {
    // CORS Header နှင့် Response Format သတ်မှတ်ခြင်း
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Content-Type', 'application/json');

    // Live Data အတွက် Variable များ တည်ဆောက်ခြင်း
    let timeData = { datetime: null, date: null, time: null };
    let marketStatus = "null";
    let set = "null";
    let value = "null";
    let twod = "null";
    let dataSource = "unknown";

    let hasHistory = false;
    let historyList = [];
    
    // ဒေတာ မရှိသေးသည့်အချိန် သို့မဟုတ် Null ဖြစ်နေချိန်တွင် ပြသမည့် Default ပုံစံ
    const defaultResult = {
        set: "--",
        value: "--",
        "2d": "--",
        datetime: "--",
        date: "--",
        time: "--",
        history_id: "--"
    };

    let noon_result = null;
    let evening_result = null;

    // Web Scraping လုပ်ရာတွင် ပိတ်ပင်မခံရစေရန် Browser ပုံစံဖန်တီးသည့် Headers
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    // [SECTION 1] TIME API မှ လက်ရှိအချိန် ဒေတာတောင်းယူခြင်း
    try {
        const timeResponse = await axios.get('https://time-api-42d.vercel.app/api/time', { timeout: 4000 });
        if (timeResponse.status === 200) {
            timeData = {
                datetime: timeResponse.data.formatted_datetime,
                date: timeResponse.data.date,
                time: timeResponse.data.time
            };
        }
    } catch (e) {}

    // Result ဖမ်းမည့်အချိန်များတွင် Cache လုံးဝမလုပ်ဘဲ Live အတိုင်းသွားရန်
    const nowTime = timeData.time; // လက်ရှိအချိန်ကို ယူတယ်
    
    // နေ့လယ် (12:00 မှ 12:03) နှင့် ညနေ (16:29 မှ 16:33) အတွင်းဖြစ်ပါက Cache မလုပ်ပါ (No Cache)
    const isNoonResultTime = nowTime && nowTime >= "12:00:00" && nowTime <= "12:03:00";
    const isEveningResultTime = nowTime && nowTime >= "16:29:00" && nowTime <= "16:32:00";

    if (isNoonResultTime || isEveningResultTime) {
        // Result ထွက်ရမည့် အရေးကြီးချိန်တွင် Cache လုံးဝပိတ်ပြီး Live တိုက်ရိုက်ဆွဲမည်
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    } else {
        // ပုံမှန်အချိန်များတွင်မူ ဒေတာဘေ့စ်ကို ကာကွယ်ရန် ၅ စက္ကန့် Cache ဖွင့်ထားမည်
        res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate');
    }

    // [SECTION 2] WEB SCRAPING - ထိုင်း SET Home Page မှ ဒေတာဆွဲခြင်း
    let success = false;
    try {
        const response = await axios.get('https://www.set.or.th/en/home', { headers, timeout: 6000 });
        const $ = cheerio.load(response.data);

        // Market Status (Open/Closed/Pre-Open1) ကို ရှာဖွေဖတ်ယူခြင်း
        $('div.text-black').each((i, el) => {
            const divText = $(el).text();
            if (divText.includes("Market Status")) {
                const spanText = $(el).find('span').text().trim();
                if (spanText) { marketStatus = spanText; return false; }
            }
        });

        // SET Index နှင့် Value ဒေတာများကို ဇယားထဲမှ ရှာဖွေဖတ်ယူခြင်း
        $('tr').each((i, el) => {
            const indexTd = $(el).find('td.title-symbol');
            if (indexTd.length > 0 && indexTd.text().trim() === 'SET') {
                const tds = $(el).find('td');
                if (tds.length >= 5) {
                    set = $(tds[1]).text().trim();
                    value = $(tds[4]).text().trim();
                    dataSource = "home Page";
                    success = true;
                    return false;
                }
            }
        });
    } catch (e) { 
        success = false; 
    }

    // [SECTION 3] BACKUP SCRAPING - Home Page မရပါက Overview Page မှ ထပ်ဆွဲခြင်း
    if (!success || set === "null" || value === "null") {
        try {
            const backupUrl = 'https://www.set.or.th/en/market/index/set/overview';
            const response = await axios.get(backupUrl, { headers, timeout: 6000 });
            const $ = cheerio.load(response.data);

            const setBox = $('.stock-info, .value.stock-info');
            if (setBox.length > 0) set = setBox.first().text().trim();

            const statusSpan = $('.quote-market-status span');
            if (statusSpan.length > 0) marketStatus = statusSpan.first().text().trim();

            const valueSpan = $('.quote-market-cost span');
            if (valueSpan.length > 0) value = valueSpan.text().trim();
            dataSource = "set overview";
        } catch (e) {}
    }

    // [SECTION 4] 2D DATA CALCULATION - လိုက်ဗ် 2D ဂဏန်းတွက်ချက်ခြင်း
    try {
        if (set !== "null") {
            const setLastDigit = set.slice(-1); 
            let valueBeforeDecimalDigit = "-";

            if (value !== "null" && value.includes('.')) {
                const decimalIndex = value.indexOf('.');
                valueBeforeDecimalDigit = value.charAt(decimalIndex - 1); 
            }

            if (value === "-") {
                twod = setLastDigit + "-";
            } else {
                twod = setLastDigit + valueBeforeDecimalDigit;
            }
        }
    } catch (e) {}

            // 🌟 [SECTION 5] (ခ) ဈေးကွက်အခြေအနေကို စစ်ဆေးပြီး Live ပြသမည့် variable များထဲသို့ ဒေတာထည့်သွင်းခြင်း
        if (marketStatus && marketStatus.includes("Closed")) {
            // ဈေးကွက်ပိတ်သော်လည်း `--` မပြောင်းတော့ဘဲ ထိုင်းဆိုက်မှရရှိသည့် နောက်ဆုံးဒေတာအစစ်ကိုသာ တိုက်ရိုက်ပြသမည်
            set = set;
            value = value;
            twod = twod; // (သင်တွက်ချက်ထားသည့် twod variable နာမည်ကို ထည့်ပါ)
        } else {
            // ဈေးကွက်ဖွင့်နေချိန် ပုံမှန်အတိုင်း ဒေတာထည့်သွင်းခြင်း
            set = set;
            value = value;
            twod = twod;
        }

    // [SECTION 6] REDIS DATABASE OPERATIONS - ဒေတာဘေ့စ် သိမ်းဆည်း/ထုတ်ယူခြင်း
    try {
        let latestHistory = await redis.lindex('2d_history_list', 0);
        const hasHistoryInDb = await redis.exists('2d_history_list');

        //  ည 12 နာရီ တွင် ရက်အသစ်ကူးပြောင်းသွားပါက History List အဟောင်းများအား ဖျက်ထုတ်ခြင်း
        if (timeData.date && latestHistory && latestHistory.date !== timeData.date) {
            if (hasHistoryInDb) {
                await redis.del('2d_history_list');
            }
            const hasIdInDb = await redis.exists('next_history_id');
            if (hasIdInDb) {
                await redis.del('next_history_id');
            }
            latestHistory = null;
        }

        // live ဒေတာ အပြောင်းအလဲရှိပါက History List ထဲသို့ အသစ်တိုးမြှင့်ထည့်သွင်းခြင်း
        if (twod && twod !== "null" && !twod.includes('-')) {
            let isDataChanged = true;

            if (latestHistory) {
                isDataChanged = latestHistory["2d"] !== twod || latestHistory["set"] !== set;
            }

            if (isDataChanged) {
                const nextHistoryId = await redis.incr('next_history_id');

                const newHistoryItem = {
                    set: set,
                    value: value,
                    "2d": twod,
                    datetime: timeData.datetime,
                    date: timeData.date,
                    time: timeData.time,
                    history_id: nextHistoryId
                };

                await redis.lpush('2d_history_list', newHistoryItem);
                await redis.ltrim('2d_history_list', 0, 29); // ဒေတာကို အခု ၃၀ သာ ကန့်သတ်သိမ်းဆည်းခြင်း
            }
        }

        // Database မှ History List (နောက်ဆုံးအကြိမ် ၃၀) ကို ပြန်ထုတ်ယူခြင်း
        historyList = await redis.lrange('2d_history_list', 0, 29);
        hasHistory = historyList.length > 0;

        const storedNoon = await redis.get('noon_result');
        const storedEvening = await redis.get('evening_result');

        // မနက် ၉:०० တွင် ဈေးကွက်ပြန်ပွင့်ချိန် လိုက်ဗ်ဒေတာနေ့က နေ့လယ်/ညနေ Result အဟောင်းများကို ရှင်းလင်းခြင်း
        if (marketStatus && marketStatus.includes("Pre-Open1")) {
            if (storedNoon && timeData.date && storedNoon.date !== timeData.date) {
                await redis.del('noon_result');
            }
            if (storedEvening && timeData.date && storedEvening.date !== timeData.date) {
                await redis.del('evening_result');
            }
        }

        // နောက်ဆုံးသိမ်းဆည်းထားသော ပိတ်ဂဏန်းဒေတာများကို Database မှ ပြန်ဖတ်ခြင်း
        noon_result = await redis.get('noon_result');
        evening_result = await redis.get('evening_result');

        const currentTime = timeData.time;

        // သတ်မှတ်အချိန်အတွင်း ရောက်ပါက History ထဲမှ နေ့လယ်/ညနေ ပိတ်ဂဏန်းကို ရှာဖွေထုတ်ယူခြင်း
        const isNoonTimeRange = currentTime && currentTime >= "12:01:00" && currentTime <= "12:03:00";
        const isEveningTimeRange = currentTime && currentTime >= "16:30:00" && currentTime <= "16:32:00";

        if (noon_result && evening_result) {
            // ဒေတာ ၂ ခုလုံး ရှိပြီးသားဖြစ်ပါက ဘာမှမလုပ်ပါ
        } 
        else if ((!noon_result && isNoonTimeRange) || (!evening_result && isEveningTimeRange)) {
            
            // History စာရင်းထဲမှ အချိန်ကွက်တိကို လှည့်ပတ်ရှာဖွေခြင်း Loop
            for (let item of historyList) {
                const itemTime = item.time;

                if (itemTime) {
                    // မနက်ပိုင်း (နေ့လယ်ပိတ်ဂဏန်း) အတွက် History ထဲမှ ရှာဖွေသိမ်းဆည်းခြင်း
                    if (!noon_result && isNoonTimeRange && itemTime >= "12:01:00" && itemTime <= "12:02:00") {
                        noon_result = item;
                        await redis.set('noon_result', noon_result);
                    }

                    // ညနေပိုင်း (ညနေပိတ်ဂဏန်း) အတွက် History ထဲမှ ရှာဖွေသိမ်းဆည်းခြင်း
                    if (!evening_result && isEveningTimeRange && itemTime >= "16:30:00" && itemTime <= "16:31:00") {
                        evening_result = item;
                        await redis.set('evening_result', evening_result);
                    }
                }
                
                if (noon_result && evening_result) {
                    break; // ဒေတာစုံသွားပါက Loop ပတ်ခြင်းကို ရပ်တန့်မည်
                }
            }
        }

    } catch (redisError) {
        historyList = [];
        hasHistory = false;
    }

    // ဒေတာ Null ဖြစ်နေရင် defaultResult (-- ပုံစံ) ကို လမ်းကြောင်းလွှဲပြီး အစားထိုးခြင်း
    const finalNoonResult = (noon_result && noon_result.set) ? noon_result : defaultResult;
    const finalEveningResult = (evening_result && evening_result.set) ? evening_result : defaultResult;

    // [SECTION 7] FINAL RESPONSE - ကာစတမ်မာထံ JSON အဖြေ ပြန်လည်ပေးပို့ခြင်း
    return res.status(200).json({
        live: {
            data_source: dataSource,
            status: marketStatus,
            set: set,
            value: value,
            "2d": twod,
            datetime: timeData.datetime,
            date: timeData.date,
            time: timeData.time
        },
        noon_result: finalNoonResult,
        evening_result: finalEveningResult,
        hasHistory: hasHistory,
        historyList: historyList
    });
};
