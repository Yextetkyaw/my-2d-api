const axios = require('axios');
const cheerio = require('cheerio');
const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv(); 

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Content-Type', 'application/json');

    let timeData = { datetime: null, date: null, time: null };
    let marketStatus = "null";
    let set = "-";
    let value = "-";
    let twod = "null";
    let dataSource = "unknown";
    
    let noonResult = "--";
    let eveningResult = "--";

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    // ၁။ Time API ကနေ ဒေတာဆွဲခြင်း
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

    const todayDate = timeData.date; // ယနေ့ရက်စွဲ

    // လက်ရှိအချိန်ရဲ့ နာရီနှင့် မိနစ်ကို ခွဲထုတ်ခြင်း (ဥပမာ - 09:01 -> hour: 9, minute: 1)
    let currentHour = 0;
    let currentMinute = 0;
    if (timeData.time) {
        const timeParts = timeData.time.split(':');
        currentHour = parseInt(timeParts[0]);
        currentMinute = parseInt(timeParts[1]);
    }

    // ၂။ Database ထဲက လက်ရှိဒေတာကို အရင်ဆွဲယူစစ်ဆေးခြင်း
    if (todayDate) {
        try {
            const savedData = await redis.get(`result:${todayDate}`);
            if (savedData) {
                noonResult = savedData.noon_result || "--";
                eveningResult = savedData.evening_result || "--";
            }
        } catch (e) {
            console.error("Redis Read Error:", e.message);
        }
    }

    // ၃။ CRON JOB အချိန်အလိုက် လုပ်ဆောင်ချက်များ
    
    // (က) မနက်ခင်း ၉:၀၀ မှ ၉:၀၃ အတွင်း - DATA RESET ချခြင်း
    if (currentHour === 9 && currentMinute >= 0 && currentMinute <= 3) {
        try {
            const savedData = await redis.get(`result:${todayDate}`);
            // ဒေတာ ရှိနေသေးရင် ဖျက်မယ်၊ မရှိတော့ရင် (ဖျက်ပြီးသားဆိုရင်) ဘာမှထပ်မလုပ်တော့ပါ
            if (savedData) {
                await redis.del(`result:${todayDate}`);
                console.log("Cron Job: 9AM Data Reset Successful.");
            }
            noonResult = "--";
            eveningResult = "--";
        } catch (e) {
            console.error("Reset Cron Error:", e.message);
        }
    }

    // (ခ) နေ့လယ် ၁၂:၀၀ မှ ၁၂:၀၃ အတွင်း - NOON DATA ထည့်ခြင်း
    if (currentHour === 12 && currentMinute >= 0 && currentMinute <= 3) {
        // ဒေတာ မရှိသေးဘူး (-- ဖြစ်နေတယ်) ဆိုမှ ရလဒ်ဆွဲပြီး ထည့်မယ်
        if (noonResult === "--") {
            try {
                const historyResponse = await axios.get('https://2d-history-api-six.vercel.app/', { timeout: 4000 });
                if (historyResponse.status === 200 && historyResponse.data) {
                    const apiNoonData = historyResponse.data.noon_record_data;
                    
                    if (apiNoonData !== null && apiNoonData !== undefined) {
                        noonResult = apiNoonData;
                        await redis.set(`result:${todayDate}`, {
                            noon_result: noonResult,
                            evening_result: eveningResult
                        });
                        console.log("Cron Job: Noon Data Added Successfully.");
                    }
                }
            } catch (e) {
                console.error("Noon Cron Error:", e.message);
            }
        }
    }

    // (ဂ) ညနေ ၄:၂၉ မှ ၄:၃၂ အတွင်း - EVENING DATA ထည့်ခြင်း
    // (၁၆ နာရီ ၂၉ မိနစ် မှ ၃၂ မိနစ်အတွင်း ၃ မိနစ်စာ သတ်မှတ်ထားပါသည်)
    if (currentHour === 16 && currentMinute >= 29 && currentMinute <= 32) {
        // ဒေတာ မရှိသေးဘူး (-- ဖြစ်နေတယ်) ဆိုမှ ရလဒ်ဆွဲပြီး ထည့်မယ်
        if (eveningResult === "--") {
            try {
                const historyResponse = await axios.get('https://2d-history-api-six.vercel.app/', { timeout: 4000 });
                if (historyResponse.status === 200 && historyResponse.data) {
                    const apiEveningData = historyResponse.data.evening_record_data;
                    
                    if (apiEveningData !== null && apiEveningData !== undefined) {
                        eveningResult = apiEveningData;
                        await redis.set(`result:${todayDate}`, {
                            noon_result: noonResult,
                            evening_result: eveningResult
                        });
                        console.log("Cron Job: Evening Data Added Successfully.");
                    }
                }
            } catch (e) {
                console.error("Evening Cron Error:", e.message);
            }
        }
    }


    // ၄။ LIVE SET ဒေတာဆွဲခြင်း (အသုံးပြုသူများ ဝင်ကြည့်ချိန် Live ပြသရန်သာ)
    let success = false;
    try {
        const response = await axios.get('https://www.set.or.th/en/home', { headers, timeout: 6000 });
        const $ = cheerio.load(response.data);

        $('div.text-black').each((i, el) => {
            const divText = $(el).text();
            if (divText.includes("Market Status")) {
                const spanText = $(el).find('span').text().trim();
                if (spanText) { marketStatus = spanText; return false; }
            }
        });

        $('tr').each((i, el) => {
            const indexTd = $(el).find('td.title-symbol');
            if (indexTd.length > 0 && indexTd.text().trim() === 'SET') {
                const tds = $(el).find('td');
                if (tds.length >= 5) {
                    set = $(tds[1]).text().trim();
                    value = $(tds[4]).text().trim();
                    success = true;
                    dataSource = "home page";
                    return false;
                }
            }
        });
    } catch (e) { success = false; }

    if (!success || set === "-" || value === "-") {
        try {
            const backupUrl = 'https://www.set.or.th/en/market/index/set/overview';
            const response = await axios.get(backupUrl, { headers, timeout: 6000 });
            const $ = cheerio.load(response.data);
            const setBox = $('.stock-info, .value.stock-info');
            if (setBox.length > 0) { set = setBox.first().text().trim(); }
            const statusSpan = $('.quote-market-status span');
            if (statusSpan.length > 0) { marketStatus = statusSpan.first().text().trim(); }
            const valueSpan = $('.quote-market-cost span');
            if (valueSpan.length > 0) { value = valueSpan.text().trim(); }
            if (set !== "-" && value !== "-") { dataSource = "set overview"; }
        } catch (e) { dataSource = "failed"; }
    }

    if (set !== "-") {
        const setLastDigit = set.slice(-1);
        let valueBeforeDecimalDigit = "-";
        if (value !== "-" && value.includes('.')) {
            const decimalIndex = value.indexOf('.');
            valueBeforeDecimalDigit = value.charAt(decimalIndex - 1);
        }
        if (value === "-") { twod = setLastDigit + "-"; } 
        else { twod = setLastDigit + valueBeforeDecimalDigit; }
    }

    if (marketStatus === "Closed") {
        set = "--"; value = "--"; twod = "--";
    }

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
        noon_result: noonResult,
        evening_result: eveningResult
    });
};
