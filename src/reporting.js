/**

Copyright 2018 New Vector Ltd.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

**/

const path = require('path');
const fs = require('fs');
const request = require('request');

const ClientError = require('./client-error.js');
const executeCommand = require('./execute-cmd.js');
const decryptFile = require('./decrypt-file.js');

const crypto = require('crypto');
function base64sha256(s) {
    const hash = crypto.createHash('sha256');
    hash.update(s);
    return hash.digest('base64');
}

function generateResultHash(httpUrl, eventContentFile=undefined) {
    // Result is cached against the hash of the input. Just using an MXC would
    // potentially allow an attacker to mark a file as clean without having the
    // keys to correctly decrypt it.
    return base64sha256(JSON.stringify({ httpUrl, eventContentFile }));
}

function generateHttpUrl(baseUrl, domain, mediaId) {
    return `${baseUrl}/_matrix/media/v1/download/${domain}/${mediaId}`;
}

// In-memory mapping between mxc:// URLs and the results generated by generateReport
let resultCache = {};
function clearReportCache() {
    resultCache = {};
}

const rimraf = require('rimraf');
function withTempDir(asyncFn) {
    return async (...args) => {
        const opts = args[args.length - 1];
        const { tempDirectory } = opts;

        const tempDir = await fs.promises.mkdtemp(`${tempDirectory}${path.sep}av-`);

        // Copy all options, overide tempDir
        args[args.length - 1] = Object.assign({}, opts, {tempDirectory: tempDir});

        let result;
        try {
            result = await asyncFn(...args);
        } finally {
            await new Promise((resolve, reject) => rimraf(tempDir, (err) => err ? reject(err) : resolve()));
        }

        return result;
    }
}

// Get cached report for the given URL
const getReport = async function(console, domain, mediaId, eventContentFile, opts) {
    const { baseUrl } = opts;

    if (eventContentFile) {
        [domain, mediaId] = eventContentFile.url.split('/').slice(-2);
    }

    const httpUrl = generateHttpUrl(baseUrl, domain, mediaId);
    const resultSecret = generateResultHash(httpUrl, eventContentFile);

    if (!resultCache[resultSecret]) {
        console.info(`File not scanned yet: domain = ${domain}, mediaId = ${mediaId}`);
        return { scanned: false };
    }
    const { clean, info } = resultCache[resultSecret];

    console.info(`Returning scan report: domain = ${domain}, mediaId = ${mediaId}, clean = ${clean}`);

    return { clean, scanned: true, info };
};

const scannedDownload = withTempDir(async function (req, res, domain, mediaId, eventContentFile, opts) {
    const {
        clean, info, filePath, headers
    } = await generateReport(req.console, domain, mediaId, eventContentFile, opts);

    if (!clean) {
        throw new ClientError(403, info);
    }

    req.console.info(`Sending ${filePath} to client`);

    const responseHeaders = {};
    const headerWhitelist = [
        'content-type',
        'content-disposition',
        'content-security-policy',
    ];
    // Copy headers from media download to response
    headerWhitelist.forEach((headerKey) => responseHeaders[headerKey] = headers[headerKey]);

    res.set(responseHeaders);
    res.sendFile(filePath);
});

// XXX: The result of this function is calculated similarly in a lot of places.
function getInputHash(_, domain, mediaId, eventContentFile, opts) {
    if (eventContentFile) {
        [domain, mediaId] = eventContentFile.url.split('/').slice(-2);
    }
    const httpUrl = generateHttpUrl(opts.baseUrl, domain, mediaId);
    return generateResultHash(httpUrl, eventContentFile);
}

// Deduplicate concurrent requests if getKey returns an identical value for identical requests
function deduplicatePromises(getKey, asyncFn) {
    const ongoing = {};
    return async (...args) => {
        const k = getKey(...args);

        if(!ongoing[k]) {
            ongoing[k] = asyncFn(...args).finally((res) => {delete ongoing[k]; return res;});
        }

        return await ongoing[k];
    };
}

const generateReport = deduplicatePromises(getInputHash, _generateReport);

// Generate a report on a Matrix file event.
async function _generateReport(console, domain, mediaId, eventContentFile, opts) {
    const { baseUrl, tempDirectory, script } = opts;
    if (baseUrl === undefined || tempDirectory === undefined || script === undefined) {
        throw new Error('Expected baseUrl, tempDirectory and script in opts');
    }

    const tempDir = tempDirectory;

    if (eventContentFile) {
        [domain, mediaId] = eventContentFile.url.split('/').slice(-2);
    }

    const httpUrl = generateHttpUrl(baseUrl, domain, mediaId);

    const filePath = path.join(tempDir, 'downloadedFile');

    console.info(`Downloading ${httpUrl}, writing to ${filePath}`);

    let downloadHeaders;
    let response;

    try {
        downloadHeaders = await new Promise((resolve, reject) => {
            let responseHeaders;
            request
                .get({url: httpUrl, encoding: null})
                .on('error', reject)
                .on('response', (response) => {
                    responseHeaders = response.headers;
                })
                .on('end', () => {
                    resolve(responseHeaders);
                })
                .pipe(fs.createWriteStream(filePath));
        });
    } catch (err) {
        if (!err.statusCode) {
            throw err;
        }

        console.error(`Receieved status code ${err.statusCode} when requesting ${httpUrl}`);

        throw new ClientError(502, 'Failed to get requested URL');
    }

    result = await generateResult(console, httpUrl, eventContentFile, filePath, tempDir, script);

    console.info(`Result: url = "${httpUrl}", clean = ${result.clean}, exit code = ${result.exitCode}`);

    result.filePath = filePath;
    result.headers = downloadHeaders;

    return result;
}

async function generateResult(console, httpUrl, eventContentFile, filePath, tempDir, script) {
    const resultSecret = generateResultHash(httpUrl, eventContentFile);
    if (resultCache[resultSecret] !== undefined) {
        console.info(`Result previously cached`);
        return resultCache[resultSecret];
    }

    // By default, the file is considered decrypted
    let decryptedFilePath = filePath;

    if (eventContentFile && eventContentFile.key) {
        decryptedFilePath = path.join(tempDir, 'unsafeDownloadedDecryptedFile');
        console.info(`Decrypting ${filePath}, writing to ${decryptedFilePath}`);

        try {
            decryptFile(filePath, decryptedFilePath, eventContentFile);
        } catch (err) {
            console.error(err);
            throw new ClientError(400, 'Failed to decrypt file');
        }
    }

    const cmd = script + ' ' + decryptedFilePath;
    console.info(`Running command ${cmd}`);
    const result = await executeCommand(cmd);

    resultCache[resultSecret] = result;

    return result;
}

module.exports = {
    getReport,
    scannedDownload,
    generateReport,
    generateResult,
    generateHttpUrl,
    clearReportCache,
};
