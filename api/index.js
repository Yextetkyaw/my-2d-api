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
    let offDay = "null";
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

    let timeResponse = null;
    
    // [SECTION 1] TIME API မှ လက်ရှိအချိန် ဒေတာတောင်းယူခြင်း
    try {
        timeResponse = await axios.get('https://time-api-42d.vercel.app/api/time', { timeout: 4000 });
        if (timeResponse && timeResponse.status === 200 && timeResponse.data) {
            timeData = {
                datetime: timeResponse.data.formatted_datetime || null,
                date: timeResponse.data.date || null,
                time: timeResponse.data.time || null
            };
        }
    } catch (e) {
        console.error("Time API Error:", e.message);
    }
    
    const currentTime = timeData.time; // လက်ရှိအချိန်ကို ယူတယ်
    
    // နေ့လယ် (12:00 မှ 12:02) နှင့် ညနေ (16:29 မှ 16:31) အတွင်းဖြစ်ပါက Cache မလုပ်ပါ (No Cache)
    const isNoonResultTime = currentTime && currentTime >= "12:00:00" && currentTime <= "12:02:00";
    const isEveningResultTime = currentTime && currentTime >= "16:29:00" && currentTime <= "16:31:00";

    if (isNoonResultTime || isEveningResultTime) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    } else {
        res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate');
    }

    // [SECTION 1.5] 🌟 Weekend (စနေ/တနင်္ဂနွေ) နှင့် Holiday API ကို တွဲဖက်စစ်ဆေးခြင်း
    try {
        if (timeResponse && timeResponse.data) {
            const dayOfWeek = timeResponse.data.day_of_week; 
            
            if (dayOfWeek === "Saturday" || dayOfWeek === "Sunday") {
                isHoliday = true;
                holidayName = "Weekend";
                offDay = dayOfWeek;
            } else {
                const holidayResponse = await axios.get('https://2d-holiday-api.vercel.app/api/holidays', { headers, timeout: 4000 });
                
                if (holidayResponse.status === 200 && holidayResponse.data && Array.isArray(holidayResponse.data.data)) {
                    const holidays = holidayResponse.data.data; 
                    
                    const tMonth = timeResponse.data.month_name ? timeResponse.data.month_name.toLowerCase() : "";
                    const tDayName = dayOfWeek ? dayOfWeek.toLowerCase() : "";
                    const tDay = timeResponse.data.day ? parseInt(timeResponse.data.day, 10) : null; 

                    const matchHoliday = holidays.find(h => {
                        const hMonth = h.month ? h.month.toLowerCase() : "";
                        const hDayName = h.day ? h.day.toLowerCase() : "";
                        const hDay = h.date ? parseInt(h.date, 10) : null; 

                        return tMonth === hMonth && tDay === hDay && tDayName === hDayName;
                    });

                 if (matchHoliday) {
                        // ၁။ အထူးရုံးပိတ်ရက် ဖြစ်ခဲ့လျှင် လုပ်ဆောင်ချက်
                        isHoliday = true; 
                        holidayName = matchHoliday.holiday_name;
                        offDay = matchHoliday.offDay; 
                 } else {
                        // ၂။ ပုံမှန်အလုပ်လုပ်ရက် (ရုံးပိတ်ရက် မဟုတ်လျှင်) လုပ်ဆောင်ချက်
                        isHoliday = false; 
                        holidayName = "Workday"; // သို့မဟုတ် ပုံမှန်နေ့မို့လို့ "Normal Workday" လို့ ပေးနိုင်ပါတယ်
                        offDay = dayOfWeek;
                    }
                }
            }
        }
    } catch (e) {
        console.error("Holiday API Error:", e.message); 
    }
    
    // [SECTION 2] WEB SCRAPING - ထိုင်း SET Home Page မှ ဒေတာဆွဲခြင်း
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
        if (set !== "null" && set !== "") {
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
        if (latestHistory && typeof latestHistory === 'string') {
            latestHistory = JSON.parse(latestHistory);
        }
        const hasHistoryInDb = await redis.exists('2d_history_list');

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

        const isNewDataTimeRange = currentTime && currentTime >= "09:30:00" && currentTime <= "16:32:00";
        
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

                // Upstash အတွက် Object ကို String ပြောင်းပြီး သိမ်းဆည်းခြင်း
                await redis.lpush('2d_history_list', JSON.stringify(newHistoryItem));
                await redis.ltrim('2d_history_list', 0, 29); 
            }
        }

        // Database မှ History List ကို ပြန်ထုတ်ယူပြီး Parse လုပ်ခြင်း
        const rawHistoryList = await redis.lrange('2d_history_list', 0, 29);
        historyList = rawHistoryList.map(item => typeof item === 'string' ? JSON.parse(item) : item);
        hasHistory = historyList.length > 0;

        let storedNoon = await redis.get('noon_result');
        if (storedNoon && typeof storedNoon === 'string') storedNoon = JSON.parse(storedNoon);

        let storedEvening = await redis.get('evening_result');
        if (storedEvening && typeof storedEvening === 'string') storedEvening = JSON.parse(storedEvening);

        if (marketStatus && marketStatus.includes("Pre-Open1")) {
            if (storedNoon && timeData.date && storedNoon.date !== timeData.date) {
                await redis.del('noon_result');
                storedNoon = null;
            }
            if (storedEvening && timeData.date && storedEvening.date !== timeData.date) {
                await redis.del('evening_result');
                storedEvening = null;
            }
        }

        noon_result = storedNoon;
        evening_result = storedEvening;

        const isNoonTimeRange = currentTime && currentTime >= "12:01:00" && currentTime <= "12:02:00";
        const isEveningTimeRange = currentTime && currentTime >= "16:30:00" && currentTime <= "16:31:00";

        if (!noon_result && isNoonTimeRange) {
            for (let item of historyList) {
                if (item.time && item.time >= "12:01:00" && item.time <= "12:02:00") {
                    noon_result = item;
                    await redis.set('noon_result', JSON.stringify(noon_result)); // String ဖြင့် သိမ်းဆည်းခြင်း
                    
                    try {
                await axios.post('https://2d-result-api.vercel.app/api/save-2d-result', {
                    type: 'noon',
                    data: noon_result
                }, { 
                    headers: { 'Authorization': 'Bearer MY_SECRET_KEY_123' },
                    timeout: 4000 
                });
                console.log("Noon result sent successfully.");
            } catch (err) {
                console.error("တခြား API သို့ Noon ပို့ရန် ပျက်ကွက်မှု:", err.message);
                    }
                    break;
                }
            }
        }

        if (!evening_result && isEveningTimeRange) {
            for (let item of historyList) {
                if (item.time && item.time >= "16:30:00" && item.time <= "16:31:00") {
                    evening_result = item;
                    await redis.set('evening_result', JSON.stringify(evening_result)); // String ဖြင့် သိမ်းဆည်းခြင်း
                    
                    try {
                await axios.post('https://2d-result-api.vercel.app/api/save-2d-result', {
                    type: 'evening',
                    data: evening_result
                }, { 
                    headers: { 'Authorization': 'Bearer MY_SECRET_KEY_123' },
                    timeout: 4000 
                });
                console.log("Evening result sent successfully.");
            } catch (err) {
                console.error("တခြား API သို့ Evening ပို့ရန် ပျက်ကွက်မှု:", err.message);
                    }
                    break;
                }
            }
        }

    } catch (redisError) {
        console.error("Redis Error:", redisError.message);
        historyList = [];
        hasHistory = false;
    }

    const finalNoonResult = (noon_result && noon_result.set) ? noon_result : defaultResult;
    const finalEveningResult = (evening_result && evening_result.set) ? evening_result : defaultResult;

    // [SECTION 6] FINAL RESPONSE - JSON အဖြေ ပြန်လည်ပေးပို့ခြင်း
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
        isHoliday: isHoliday,
        holidayName: holidayName,
        offDay: offDay,
        hasHistory: hasHistory,
        historyList: historyList
    });
};
