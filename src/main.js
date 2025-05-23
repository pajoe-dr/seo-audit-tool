const Apify = require('apify');

const { log, enqueueLinks } = Apify.utils;
const { PseudoUrl } = Apify;

const { basicSEO } = require('./seo.js');
const { jsonLdLookup, microdataLookup } = require('./ontology_lookups.js');

Apify.main(async () => {
    const {
        startUrl,
        proxy,
        maxRequestsPerCrawl,
        maxDepth,
        seoParams,
        userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.125 Safari/537.36',
        viewPortWidth,
        viewPortHeight,
        pageTimeout,
        maxRequestRetries,
        handlePageTimeoutSecs = 3600
    } = await Apify.getValue('INPUT');

    log.info(`SEO audit for ${startUrl} started`);

    const { hostname } = new URL(startUrl);
    const pseudoUrl = new PseudoUrl(`[http|https]://[.*]${hostname}[.*]`);

    const proxyConfiguration = await Apify.createProxyConfiguration({ ...proxy }) || undefined;
    const requestQueue = await Apify.openRequestQueue();
    await requestQueue.addRequest({ url: startUrl });

    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        proxyConfiguration,
        useSessionPool: true,
        gotoFunction: async ({ request, page }) => {
            await page.setBypassCSP(true);
            if (userAgent) await page.setUserAgent(userAgent);
            if (viewPortWidth && viewPortHeight) {
                await page.setViewport({ width: viewPortWidth, height: viewPortHeight });
            }
            return page.goto(request.url, {
                waitUntil: 'networkidle2',
                timeout: pageTimeout,
            });
        },
        launchPuppeteerOptions: {
            ignoreHTTPSErrors: true,
            args: [
                '--allow-running-insecure-content',
                '--disable-web-security',
                '--enable-features=NetworkService',
                '--ignore-certificate-errors',
            ],
        },
        maxRequestRetries,
        maxRequestsPerCrawl,
        handlePageTimeoutSecs,
        handlePageFunction: async ({ request, page }) => {
            log.info('Start processing', { url: request.url });

            // Enhanced: capture all fields from basicSEO, jsonLdLookup, microdataLookup
            const seoData = await basicSEO(page, seoParams);
            const jsonLdData = await jsonLdLookup(page);
            const microdataData = await microdataLookup(page);

            const data = {
                url: page.url(),
                title: await page.title(),
                isLoaded: true,
                ...seoData,
                jsonLd: jsonLdData,
                microdata: microdataData
            };

            await Apify.pushData(data);

            const enqueueResults = await enqueueLinks({
                page,
                selector: 'a[href]:not([target="_blank"]):not([rel*="nofollow"]):not([rel*="noreferrer"])',
                pseudoUrls: [pseudoUrl],
                requestQueue,
                transformRequestFunction: (r) => {
                    const url = new URL(r.url);
                    url.pathname = url.pathname
                        .split('/')
                        .filter(Boolean)
                        .slice(0, maxDepth)
                        .join('/');
                    return { url: url.toString() };
                },
            });

            const newRequests = enqueueResults.filter(r => !r.wasAlreadyPresent);
            if (newRequests.length) log.info(`${request.url}: Added ${newRequests.length} urls to queue.`);
            log.info(`${request.url}: Finished`);
        },

        handleFailedRequestFunction: async ({ request, error }) => {
            log.info(`Request ${request.url} failed too many times`);
            await Apify.pushData({
                url: request.url,
                isLoaded: false,
                errorMessage: error.message,
            });
        },
    });

    await crawler.run();
    log.info(`SEO audit for ${startUrl} finished.`);
});
