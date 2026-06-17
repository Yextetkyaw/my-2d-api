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

    let isHoliday = false;
    let holidayName = "null";
    let offDay = "null",
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

    let timeResponse;
    
    // [SECTION 1] TIME API မှ လက်ရှိအချိန် ဒေတာတောင်းယူခြင်း
    try {
        timeResponse = await axios.get('https://time-api-42d.vercel.app/api/time', { timeout: 4000 });
        if (timeResponse.status === 200) {
            timeData = {
                datetime: timeResponse.data.formatted_datetime,
                date: timeResponse.data.date,
                time: timeResponse.data.time
            };
        }
    } catch (e) {}
    
    const currentTime = timeData.time; // လက်ရှိအချိန်ကို ယူတယ်
    
    // နေ့လယ် (12:00 မှ 12:02) နှင့် ညနေ (16:29 မှ 16:31) အတွင်းဖြစ်ပါက Cache မလုပ်ပါ (No Cache)
    const isNoonResultTime = currentTime  && currentTime  >= "12:00:00" && currentTime  <= "12:02:00";
    const isEveningResultTime = currentTime  && currentTime  >= "16:29:00" && currentTime  <= "16:31:00";

    if (isNoonResultTime || isEveningResultTime) {
        // Result ထွက်ရမည့် အရေးကြီးချိန်တွင် Cache လုံးဝပိတ်ပြီး Live တိုက်ရိုက်ဆွဲမည်
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    } else {
        // ပုံမှန်အချိန်များတွင်မူ ဒေတာဘေ့စ်ကို ကာကွယ်ရန် ၅ စက္ကန့် Cache ဖွင့်ထားမည်
        res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate');
    }

  // [SECTION 1.5] 🌟 Weekend (စနေ/တနင်္ဂနွေ) နှင့် Holiday API ကို တွဲဖက်စစ်ဆေးခြင်း
try {
    if (timeResponse && timeResponse.data) {
        const dayOfWeek = timeResponse.data.day_of_week; // စာသားဖြင့် လာမည် (ဥပမာ- "Friday")
        
        // ၁။ ဦးဆုံး စနေ သို့မဟုတ် တနင်္ဂနွေ ဟုတ်မဟုတ် အရင်စစ်တယ်
        if (dayOfWeek === "Saturday" || dayOfWeek === "Sunday") {
            isHoliday = true;
            holidayName = "Weekend";
            offDay = dayOfWeek;
        } else {
            // ၂။ စနေ/တနင်္ဂနွေ မဟုတ်ရင် ထိုင်းအထူးရုံးပိတ်ရက် API ကို လှမ်းခေါ်ပြီး စစ်ဆေးမယ်
            const holidayResponse = await axios.get('https://2d-holiday-api.vercel.app/api/holidays', { headers, timeout: 4000 });
            
            // ပြင်ဆင်ချက်- holidayResponse.data ထဲကမှ .data (Array) ရှိမရှိကို သေချာစစ်ဆေးခြင်း
            if (holidayResponse.status === 200 && holidayResponse.data && Array.isArray(holidayResponse.data.data)) {
                const holidays = holidayResponse.data.data; // API Object ထဲက holidays array ကို ဆွဲထုတ်လိုက်တယ်
                
                // Time API မှ ဒေတာများကို စာလုံးအသေး ပြောင်းခြင်း နှင့် ရှေ့က သုည (0) ဖြုတ်ခြင်း
                const tMonth = timeResponse.data.month_name ? timeResponse.data.month_name.toLowerCase() : "";
                const tDayName = dayOfWeek ? dayOfWeek.toLowerCase() : "";
                const tDay = timeResponse.data.day ? parseInt(timeResponse.data.day, 10) : null; 

                // Holiday List ထဲမှာ ကိုက်ညီတာ ရှိမရှိ Loop ပတ်စစ်ဆေးခြင်း
                const matchHoliday = holidays.find(h => {
                    // Holiday API မှ ဒေတာများကို စာလုံးအသေး ပြောင်းခြင်း
                    const hMonth = h.month ? h.month.toLowerCase() : "";
                    const hDayName = h.day ? h.day.toLowerCase() : "";
                    const hDay = h.date ? h.date : null; // ပြင်ဆင်ချက်- API မှာ ပေးထားတာ ကိန်းပြည့် (Number) ဖြစ်လို့ parseInt မလိုတော့ပါ

                    return tMonth === hMonth && tDay === hDay && tDayName === hDayName;
                });

                if (matchHoliday) {
                    isHoliday = true; 
                    holidayName = matchHoliday.holiday_name;
                    offDay = matchHoliday.offDay; 
                }
            }
        }
    }
} catch (e) {
    // API Error တက်ခဲ့ရင်တောင် စနေ/တနင်္ဂနွေ စစ်ချက်က အပေါ်မှာ အရင်အလုပ်လုပ်သွားလို့ စိတ်ချရပါတယ်
    console.error("Holiday API Error:", e.message); // Debug လုပ်ရလွယ်အောင် error print ထုတ်ထားပေးနိုင်ပါတယ်
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

    // [SECTION 5] REDIS DATABASE OPERATIONS - ဒေတာဘေ့စ် သိမ်းဆည်း/ထုတ်ယူခြင်း
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

        const isNewDataTimeRange = currentTime && currentTime >= "09:29:00" && currentTime <= "16:31:00";
        
        // live ဒေတာ အပြောင်းအလဲရှိပါက History List ထဲသို့ အသစ်တိုးမြှင့်ထည့်သွင်းခြင်း
        if (!isHoliday && isNewDataTimeRange && (twod && twod !== "null") && !twod.includes('-')) {
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

        // သတ်မှတ်အချိန်အတွင်း ရောက်ပါက History ထဲမှ နေ့လယ်/ညနေ ပိတ်ဂဏန်းကို ရှာဖွေထုတ်ယူခြင်း
        const isNoonTimeRange = currentTime && currentTime >= "12:01:00" && currentTime <= "12:02:00";
        const isEveningTimeRange = currentTime && currentTime >= "16:30:00" && currentTime <= "16:31:00";

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

    // [SECTION 6] FINAL RESPONSE - ကာစတမ်မာထံ JSON အဖြေ ပြန်လည်ပေးပို့ခြင်း
    return res.status(200).json({
        live: {
            data_source: dataSource,
            status: marketStatus,
            set: set,
            value: value,
            2d: twod,
            datetime: timeData.datetime,
            date: timeData.date,
            time: timeData.time
        },
        noon_result: finalNoonResult,
        evening_result: finalEveningResult,
        isHoliday: isHoliday,
        holidayName: holidayName,
        offDay: offDay,
        hasHistory: hasHistory,
        historyList: historyList
    });
};
