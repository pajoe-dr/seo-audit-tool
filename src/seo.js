const Apify = require('apify');
const Bluebird = require('bluebird');

const { injectJQuery } = Apify.utils.puppeteer;

const DEFAULT_SEO_PARAMS = {
    maxTitleLength: 70,
    minTitleLength: 10,
    maxMetaDescriptionLength: 140,
    maxLinksCount: 3000,
    maxWordsCount: 350,
    outputLinks: false,
    workingStatusCodes: [200, 301, 302, 304],
};

/**
 * @param {Puppeteer.Page} page
 * @param {any} userParams
 */
async function basicSEO(page, userParams = {}) {
    await injectJQuery(page);
    const seoParams = {
        ...DEFAULT_SEO_PARAMS,
        ...userParams,
    };
    const { origin, hostname } = new URL(page.url());

    const fetchInBrowser = (url) => page.evaluate(async (pUrl) => {
        try {
            const { status } = await window.fetch(pUrl, {
                method: 'GET',
                mode: 'no-cors',
                headers: { Accept: '*/*' },
                referrerPolicy: 'no-referrer',
            });
            return status;
        } catch {
            return 500;
        }
    }, url);

    const seo = await page.evaluate((params, hostname) => {
        const $ = window.jQuery;
        const result = {};

        // Flash detection
        result.isUsingFlash = $('script:contains(embedSWF)').length > 0;

        // Google Analytics
        result.isGoogleAnalyticsObject = typeof ga !== 'undefined';
        result.isGoogleAnalyticsFunc = $('script:contains(function(i,s,o,g,r,a,m){i[\'GoogleAnalyticsObject\'])').length > 0;

        // Character encoding
        result.isCharacterEncode = !!$('meta[charset]').length;

        // Meta description
        result.isMetaDescription = !!$('meta[name=description]').length;
        if (result.isMetaDescription) {
            result.metaDescription = $('meta[name=description]').attr('content');
            result.isMetaDescriptionEnoughLong = result.metaDescription.length < params.maxMetaDescriptionLength;
        }

        // Doctype
        result.isDoctype = !!document.doctype;

        // Title
        const title = $('title').text();
        result.isTitle = !!title;
        result.title = title;
        result.isTitleEnoughLong = title.length >= params.minTitleLength && title.length <= params.maxTitleLength;

        // H1/H2 tags
        const h1Count = $('h1').length;
        result.isH1 = h1Count > 0;
        result.h1 = $('h1').first().text();
        result.isH1OnlyOne = h1Count === 1;
        result.isH2 = $('h2').length > 0;

        // ALL links, internal/external separation
        const $allLinks = $('a[href]');
        result.linksCount = $allLinks.length;
        result.isTooEnoughLinks = result.linksCount < params.maxLinksCount;

        // Internal nofollow links
        result.internalNoFollowLinks = $allLinks
            .filter((_, el) => $(el).attr('rel') === 'nofollow' && el.href.includes(hostname))
            .map((_, el) => el.href)
            .toArray();
        result.internalNoFollowLinksCount = result.internalNoFollowLinks.length;

        // All link URLs, separated
        result.linkUrls = $allLinks
            .filter((_, el) => {
                const href = $(el).attr('href');
                return href && !href.includes('javascript:') && !href.includes('mailto:');
            })
            .map((_, el) => el.href)
            .toArray();
        result.internalLinks = result.linkUrls.filter(url => url.includes(hostname));
        result.externalLinks = result.linkUrls.filter(url => !url.includes(hostname));

        // Image alt attributes
        result.imageAlts = [];
        result.imageUrls = [];
        result.notOptimizedImages = [];

        $('img').each((_, el) => {
            const src = el.src;
            const alt = $(el).attr('alt') || '';
            result.imageUrls.push(src);
            result.imageAlts.push({ src, alt });
            if (!alt.trim()) result.notOptimizedImages.push(src);
        });

        result.notOptimizedImagesCount = result.notOptimizedImages.length;

        // Remove nav, aside, footer for word count
        $('nav, aside, footer').remove();
        result.wordsCount = document.body.innerText.split(/\b(\p{Letter}+)\b/gu).filter(Boolean).length;
        result.isContentEnoughLong = result.wordsCount < params.maxWordsCount;

        // Viewport, AMP, iframe checks
        result.isViewport = !!$('meta[name=viewport]').length;
        result.isAmp = !!$('html[⚡], html[amp]').length;
        result.isNotIframe = !$('iframe').length;

        // Robots and googlebot meta tags
        result.pageIsBlocked = $('meta[name=robots][content], meta[name=googlebot][content]')
            .filter((_, el) => ['noindex', 'nofollow'].some(flag => el.content.includes(flag)))
            .length > 0;

        result.robotsMeta = $('meta[name=robots]').attr('content') || null;
        result.googlebotMeta = $('meta[name=googlebot]').attr('content') || null;

        // Canonical tag
        result.canonicalLink = $('link[rel="canonical"]').attr('href') || null;

        return result;
    }, seoParams, hostname);

    const { workingStatusCodes } = seoParams;

    seo.robotsFileExists = workingStatusCodes.includes(await fetchInBrowser(`${origin}/robots.txt`));
    seo.faviconExists = workingStatusCodes.includes(await fetchInBrowser(`${origin}/favicon.ico`));

    // Broken link checks
    const internalBrokenLinks = new Set();
    const allBrokenLinks = new Set();

    await Bluebird.map(seo.internalLinks, async (url) => {
        if (!internalBrokenLinks.has(url)) {
            const res = await fetchInBrowser(url);
            if (!workingStatusCodes.includes(res)) internalBrokenLinks.add(url);
        }
    }, { concurrency: 2 });

    seo.brokenLinksCount = internalBrokenLinks.size;
    seo.brokenLinks = [...internalBrokenLinks];

    await Bluebird.map(seo.externalLinks, async (url) => {
        if (!allBrokenLinks.has(url)) {
            const res = await fetchInBrowser(url);
            if (!workingStatusCodes.includes(res)) allBrokenLinks.add(url);
        }
    }, { concurrency: 2 });

    seo.externalBrokenLinksCount = allBrokenLinks.size;
    seo.externalBrokenLinks = [...allBrokenLinks];

    if (!seoParams.outputLinks) {
        delete seo.internalLinks;
        delete seo.externalLinks;
        delete seo.linkUrls;
    }

    // Broken images
    seo.brokenImages = [];
    await Bluebird.map(seo.imageUrls, async (imageUrl) => {
        const res = await fetchInBrowser(imageUrl);
        if (!workingStatusCodes.includes(res)) seo.brokenImages.push(imageUrl);
    }, { concurrency: 2 });

    seo.brokenImagesCount = seo.brokenImages.length;
    delete seo.imageUrls;

    return seo;
}

module.exports = {
    basicSEO,
};
