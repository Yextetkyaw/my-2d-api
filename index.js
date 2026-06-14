const axios = require('axios');
const cheerio = require('cheerio');

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
    
    // Result အသစ်များအတွက် Variable သတ်မှတ်ခြင်း
    let noonResult = null;
    let eveningResult = null;

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    // Time API ကနေ ဒေတာဆွဲခြင်း
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

    // 2D History API ကနေ Noon နဲ့ Evening ဒေတာများ ဆွဲယူခြင်း
    try {
        const historyResponse = await axios.get('https://2d-history-api.vercel.app/', { timeout: 4000 });
        if (historyResponse.status === 200 && historyResponse.data) {
            noonResult = historyResponse.data.noon_record_data || null;
            eveningResult = historyResponse.data.evening_record_data || null;
        }
    } catch (e) {
        // API တက်မလာရင် သို့မဟုတ် Timeout ဖြစ်ရင် null အဖြစ်ပဲ ထားရှိပါမယ်
    }

    // နည်းလမ်း (၁) - မူလ Home Page ကနေ ဒေတာဆွဲခြင်း
    let success = false;
    try {
        const response = await axios.get('https://www.set.or.th/en/home', { headers, timeout: 6000 });
        const $ = cheerio.load(response.data);

        // Home Page ရဲ့ Market Status ကို ယူခြင်း
        $('div.text-black').each((i, el) => {
            const divText = $(el).text();
            if (divText.includes("Market Status")) {
                const spanText = $(el).find('span').text().trim();
                if (spanText) {
                    marketStatus = spanText;
                    return false;
                }
            }
        });

        // Table rows ထဲက SET value ဒေတာ ရှာဖွေခြင်း
        $('tr').each((i, el) => {
            const indexTd = $(el).find('td.title-symbol');
            if (indexTd.length > 0 && indexTd.text().trim() === 'SET') {
                const tds = $(el).find('td');
                if (tds.length >= 5) {
                    set = $(tds[1]).text().trim();
                    value = $(tds[4]).text().trim();
                    success = true;
                    dataSource = "home page"; // Home Page ကရရင် တန်ဖိုးသတ်မှတ်မယ်
                    return false;
                }
            }
        });
    } catch (e) {
        success = false;
    }

    // နည်းလမ်း (၂) - ၁ မရခဲ့လျှင် Overview Page ကနေ Backup ဆွဲခြင်း
    if (!success || set === "-" || value === "-") {
        try {
            const backupUrl = 'https://www.set.or.th/en/market/index/set/overview';
            const response = await axios.get(backupUrl, { headers, timeout: 6000 });
            const $ = cheerio.load(response.data);

            // SET ကို ယူခြင်း
            const setBox = $('.stock-info, .value.stock-info');
            if (setBox.length > 0) {
                set = setBox.first().text().trim();
            }

            // Status ကို ယူခြင်း
            const statusSpan = $('.quote-market-status span');
            if (statusSpan.length > 0) {
                marketStatus = statusSpan.first().text().trim();
            }

            // Value ကို ယူခြင်း
            const valueSpan = $('.quote-market-cost span');
            if (valueSpan.length > 0) {
                value = valueSpan.text().trim();
            }

            if (set !== "-" && value !== "-") {
                dataSource = "set overview"; // Overview Page ကရရင် တန်ဖိုးသတ်မှတ်မယ်
            }
        } catch (e) {
            dataSource = "failed"; // နှစ်ခုလုံးဆွဲမရရင် failed ဖြစ်မယ်
        }
    }

    // 2D ဂဏန်း တွက်ချက်ခြင်း
    if (set !== "-") {
        const setLastDigit = set.slice(-1); // SET ရဲ့ နောက်ဆုံးလုံးကို ယူတယ်
        let valueBeforeDecimalDigit = "-";

        // Value က "-" မဟုတ်ဘဲ ဒဿမပါဝင်နေတယ်ဆိုရင် ဒဿမရှေ့က တစ်လုံးကို ယူမယ်
        if (value !== "-" && value.includes('.')) {
            const decimalIndex = value.indexOf('.');
            valueBeforeDecimalDigit = value.charAt(decimalIndex - 1);
        }

        // Value က "-" ဖြစ်နေသေးရင် 2D ရဲ့ ဒုတိယလုံးကို "-" လို့ပြမယ်
        if (value === "-") {
            twod = setLastDigit + "-"; // ဥပမာ - "1-"
        } else {
            twod = setLastDigit + valueBeforeDecimalDigit; // ဒေတာစုံရင် "11"
        }
    }

    // Market Status က Closed ဖြစ်နေလျှင် set,value,2d ဒေတာများကို -- သို့ပြောင်းလဲခြင်း
    if (marketStatus === "Closed") {
        set = "--";
        value = "--";
        twod = "--";
    }

    // ရလဒ်ကို Live Object အဖြစ် ပေးပို့ခြင်း
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
