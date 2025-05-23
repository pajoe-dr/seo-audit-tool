const microdataParser = require('microdata-node');
const Apify = require('apify');

const jsonLdLookup = async (page) => {
    let isJsonLd = false;
    let jsonLdData = [];

    const handles = await page.$$eval('script[type="application/ld+json"]', scripts =>
        scripts.map(s => s.textContent.trim())
    );

    if (handles.length > 0) {
        isJsonLd = true;
        for (const rawJson of handles) {
            try {
                const parsed = JSON.parse(rawJson);
                jsonLdData.push(parsed);
            } catch (e) {
                Apify.utils.log.warning(`Parsing LD+JSON failed: ${e.message}`);
            }
        }
    }

    return { isJsonLd, jsonLdData };
};

const microdataLookup = async (page) => {
    let isMicrodata = false;
    const pageHtml = await page.evaluate(() => document.documentElement.outerHTML);
    const microdata = microdataParser.toJsonld(pageHtml, {});
    if (microdata.length) isMicrodata = true;

    return { isMicrodata, microdata };
};

module.exports = {
    microdataLookup,
    jsonLdLookup,
};
