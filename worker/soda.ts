// worker/soda.ts
// 汽水音乐（字节）的同源反代。浏览器只调 /api/soda/*，这里负责：
//   /api/soda/search?q=&limit=&offset=  匿名搜索（api.qishui.com/luna/search/track）
//   /api/soda/track?id=                 取播放直链（第三方解析服务，请求体 AES-256-GCM 加密）
//   /api/soda/qr                        取登录二维码（passport get_qrcode，扫码用抖音 App）
//   /api/soda/qr/status                 轮询扫码状态，确认后返回 sessionid
// 说明：汽水没有公开 API。搜索靠一套 Android 设备参数匿名可用；播放直链官方接口匿名会返回空 body，
// 所以走社区解析服务（SODA_PARSE_BASE 可换）。扫码登录用 passport 的 web 接口，不需要额外签名；
// 二维码会话的 Cookie 由前端在两次请求之间带回（Worker 不保存状态）。两者都可能随时失效，失败时返回可读的 JSON 错误。

const SEARCH_URL = 'https://api.qishui.com/luna/search/track';
const PC_API_HOST = 'https://api.qishui.com';
const DEFAULT_PARSE_BASE = 'https://qiuyu520.fun/qishuiParse';
// 解析请求体的 AES-256-GCM 密钥（来自社区实现，社区改版时这里也要跟着换）。
const PARSE_KEY_HEX = 'bf0e991833b2bdfc27f621f01b9a65348f3e89484362cdcc77e6d1606b4a3584';
// passport 的固定 SDK 参数（与汽水 PC 客户端一致）。
const PASSPORT_FIXED = {
    aid: '386088',
    passport_jssdk_version: '2.4.13',
    passport_jssdk_type: 'normal',
    is_from_ttaccountsdk: '1',
    next: 'https://api.qishui.com',
    need_logo: 'false',
    need_short_url: 'false',
    is_frontier: 'true',
    is_new_login: '1',
    iid: '27960026095955',
    version_code: '30020100',
};
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, 'access-control-allow-origin': '*' },
});

const errorJson = (message: string, status = 502): Response => json({ error: message }, status);

const decodeHex = (hex: string): Uint8Array => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
};

const toBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
};

/** 搜索请求的固定设备参数：aid/iid/device_id 缺一不可，缺了会被风控。 */
const searchParams = (q: string, limit: number, offset: number): Record<string, string> => ({
    device_platform: 'android',
    os: 'android',
    ssmix: 'a',
    cdid: '46556f98-1720-4248-83da-62b74b60b46a',
    channel: 'xiaomi_8478_64',
    aid: '386088',
    app_name: 'luna',
    version_code: '100198030',
    version_name: '19.8.0',
    manifest_version_code: '100198030',
    update_version_code: '100198030',
    resolution: '1080*1920',
    dpi: '480',
    device_type: 'ABR-AL80',
    device_brand: 'HUAWEI',
    language: 'zh',
    os_api: '35',
    os_version: '15',
    ac: 'wifi',
    device_model: 'ABR-AL80',
    save_power: '0',
    font_size: '1.00',
    package: 'com.luna.music',
    iid: '2204957404569386',
    device_id: '2204957404565290',
    _rticket: String(Date.now()),
    q,
    cursor: String(offset),
    count: String(limit),
});

type SodaCover = { uri?: string; urls?: string[]; template_prefix?: string } | undefined;

const coverUrlOf = (cover: SodaCover): string => {
    if (!cover?.uri || !cover.urls?.length) return '';
    const base = cover.urls[0] || '';
    const suffix = cover.template_prefix ? `~${cover.template_prefix}.jpeg` : '';
    return `${base}${cover.uri}${suffix}`;
};

type SodaTrack = {
    id?: string;
    name?: string;
    duration?: number;
    artists?: Array<{ name?: string }>;
    album?: { name?: string; url_cover?: SodaCover };
};

const searchSoda = async (q: string, limit: number, offset: number): Promise<Response> => {
    const query = new URLSearchParams(searchParams(q, limit, offset));
    let response: Response;
    try {
        response = await fetch(`${SEARCH_URL}?${query}`, {
            headers: {
                'user-agent': 'com.luna.music/100198030 (Linux; U; Android 15; zh_CN; ABR-AL80)',
                accept: 'application/json',
            },
        });
    } catch (error) {
        return errorJson(`soda search unreachable: ${String(error)}`);
    }
    if (!response.ok) return errorJson(`soda search failed with ${response.status}`, response.status);
    let payload: any;
    try {
        payload = await response.json();
    } catch {
        return errorJson('soda search returned a non-JSON body');
    }
    const group = Array.isArray(payload?.result_groups) ? payload.result_groups[0] || {} : {};
    const rows = Array.isArray(group.data) ? group.data : [];
    const items = rows
        .map((row: any) => row?.entity?.track as SodaTrack | undefined)
        .filter((track): track is SodaTrack => Boolean(track?.id))
        .map((track) => ({
            id: String(track.id),
            title: String(track.name || ''),
            artist: (track.artists || []).map(artist => String(artist?.name || '')).filter(Boolean).join(', '),
            album: String(track.album?.name || ''),
            cover: coverUrlOf(track.album?.url_cover),
            durationMs: Math.max(0, Number(track.duration) || 0),
        }));
    return json({
        items,
        total: Number(group.total || 0) || undefined,
        hasMore: Boolean(group.has_more),
    });
};

/** 第三方解析：请求体是 base64(nonce || AES-256-GCM(明文))，明文里带 track_id。 */
const encryptParseBody = async (trackId: string): Promise<string> => {
    const key = await crypto.subtle.importKey('raw', decodeHex(PARSE_KEY_HEX), { name: 'AES-GCM' }, false, ['encrypt']);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify({
        t: Date.now(),
        n: toBase64(crypto.getRandomValues(new Uint8Array(16))),
        b: { track_id: trackId },
    }));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext));
    const packed = new Uint8Array(nonce.length + ciphertext.length);
    packed.set(nonce, 0);
    packed.set(ciphertext, nonce.length);
    return toBase64(packed);
};

const trackSoda = async (id: string, parseBase: string): Promise<Response> => {
    let payload: string;
    try {
        payload = await encryptParseBody(id);
    } catch (error) {
        return errorJson(`soda parse encrypt failed: ${String(error)}`, 500);
    }
    let response: Response;
    try {
        response = await fetch(`${parseBase}/api/track_v2?_=${Date.now() * 1000}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/plain, */*',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36',
                origin: 'https://qiuyu520.fun',
                referer: 'https://qiuyu520.fun/qishui/',
            },
            body: JSON.stringify({ d: payload }),
        });
    } catch (error) {
        return errorJson(`soda parse unreachable: ${String(error)}`);
    }
    if (!response.ok) return errorJson(`soda parse failed with ${response.status}`, response.status);
    let body: any;
    try {
        body = await response.json();
    } catch {
        return errorJson('soda parse returned a non-JSON body');
    }
    const data = body?.data || {};
    const url = String(data.url || '');
    if (!url) return errorJson(`soda parse returned no url: ${String(body?.msg || body?.error || '')}`, 502);
    return json({
        url,
        playAuth: String(data.playAuth || ''),
        title: String(data.title || ''),
        artist: String(data.artist || ''),
        album: String(data.album || ''),
        cover: String(data.cover || ''),
    });
};

/** Workers 里 set-cookie 可能有多条：新的 getSetCookie() 拿数组，老的只有一条合并串。 */
const setCookiesOf = (response: Response): string[] => {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
    const raw = response.headers.get('set-cookie');
    return raw ? [raw] : [];
};

/** 把 set-cookie 收成一次请求能带回去的 Cookie 头。 */
const cookieHeaderOf = (response: Response): string => setCookiesOf(response)
    .map(line => line.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');

const sessionIdOf = (response: Response): string => {
    for (const line of setCookiesOf(response)) {
        const match = line.match(/(?:^|[;,\s])sessionid=([^;,\s]+)/i);
        if (match) return match[1];
    }
    return '';
};

/**
 * 取登录二维码。passport 的 web 接口不需要额外签名；创建二维码时下发的 Cookie 必须带到轮询请求里，
 * 但 Worker 是无状态的，所以把它原样返回给前端，由前端在 status 请求里带回来。
 */
const qrSoda = async (): Promise<Response> => {
    const params = new URLSearchParams(PASSPORT_FIXED);
    let response: Response;
    try {
        response = await fetch(`${PC_API_HOST}/passport/web/get_qrcode/?${params}`, {
            headers: { 'user-agent': WEB_UA, accept: 'application/json' },
        });
    } catch (error) {
        return errorJson(`soda qr unreachable: ${String(error)}`);
    }
    if (!response.ok) return errorJson(`soda qr failed with ${response.status}`, response.status);
    let payload: any;
    try {
        payload = await response.json();
    } catch {
        return errorJson('soda qr returned a non-JSON body');
    }
    const data = payload?.data?.data ?? payload?.data ?? {};
    const token = String(data.token || '');
    const qrImage = String(data.qrcode || '');
    if (!token || !qrImage) {
        return errorJson(`soda qr returned no token/qrcode: ${String(payload?.message || '')}`, 502);
    }
    return json({
        token,
        qrImage,
        expireTime: Number(data.expire_time) || 0,
        cookie: cookieHeaderOf(response),
        scanApp: String(data.copywriting || '').includes('抖音') ? 'douyin' : '',
    });
};

/** 轮询扫码状态：new / scanned / confirmed / expired，确认后带上 sessionid。 */
const qrStatusSoda = async (request: Request): Promise<Response> => {
    let body: any = {};
    try {
        body = await request.json();
    } catch {
        body = {};
    }
    const token = String(body?.token || '').trim();
    const cookie = String(body?.cookie || '').trim();
    if (!token) return errorJson('token is required', 400);
    const form = new URLSearchParams({
        passport_jssdk_version: PASSPORT_FIXED.passport_jssdk_version,
        passport_jssdk_type: PASSPORT_FIXED.passport_jssdk_type,
        is_from_ttaccountsdk: PASSPORT_FIXED.is_from_ttaccountsdk,
        aid: PASSPORT_FIXED.aid,
        iid: PASSPORT_FIXED.iid,
        need_logo: PASSPORT_FIXED.need_logo,
        need_short_url: PASSPORT_FIXED.need_short_url,
        is_frontier: PASSPORT_FIXED.is_frontier,
        is_new_login: PASSPORT_FIXED.is_new_login,
        next: PASSPORT_FIXED.next,
        token,
    });
    let response: Response;
    try {
        response = await fetch(`${PC_API_HOST}/passport/web/check_qrconnect/`, {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'user-agent': WEB_UA,
                accept: 'application/json',
                ...(cookie ? { cookie } : {}),
            },
            body: form.toString(),
        });
    } catch (error) {
        return errorJson(`soda qr status unreachable: ${String(error)}`);
    }
    if (!response.ok) return errorJson(`soda qr status failed with ${response.status}`, response.status);
    let payload: any;
    try {
        payload = await response.json();
    } catch {
        return errorJson('soda qr status returned a non-JSON body');
    }
    // 上游在「已确认」这一步的响应结构会变：status 可能只出现在 data 层，甚至缺失。
    // 这里按多路径取值，并且只要拿到 sessionid 就一律按 confirmed 处理（sessionid 才是登录成功的凭据）。
    const outer = payload?.data ?? {};
    const inner = outer?.data ?? {};
    const status = String(outer.status ?? inner.status ?? payload?.status ?? '').trim();
    const sessionid = sessionIdOf(response);
    const errorCode = Number(outer.error_code ?? inner.error_code ?? payload?.error_code ?? 0) || 0;
    return json({
        status: sessionid ? 'confirmed' : status,
        sessionid,
        errorCode,
        // 状态既不是已知值又没有 sessionid 时，把响应骨架带回去，方便定位（不含 Cookie）。
        trace: status || sessionid ? undefined : {
            keys: Object.keys(outer).slice(0, 12),
            message: String(payload?.message || '').slice(0, 80),
            statusRaw: String(payload?.status ?? ''),
        },
    });
};

/** 带登录态请求 PC 账号接口。sessionid 由前端在登录成功后保存并回传。 */
const accountSoda = async (path: string, sessionid: string): Promise<Response> => {
    if (!sessionid) return errorJson('sessionid is required', 401);
    const query = new URLSearchParams({
        aid: PASSPORT_FIXED.aid,
        iid: PASSPORT_FIXED.iid,
        version_code: PASSPORT_FIXED.version_code,
    });
    let response: Response;
    try {
        response = await fetch(`${PC_API_HOST}${path}?${query}`, {
            headers: {
                'user-agent': WEB_UA,
                accept: 'application/json',
                cookie: `sessionid=${sessionid};`,
            },
        });
    } catch (error) {
        return errorJson(`soda account unreachable: ${String(error)}`);
    }
    const text = await response.text();
    if (!response.ok) return errorJson(`soda account failed with ${response.status}: ${text.slice(0, 200)}`, response.status);
    try {
        return json(JSON.parse(text));
    } catch {
        return errorJson('soda account returned a non-JSON body');
    }
};

export const handleSoda = async (request: Request, url: URL, parseBase = DEFAULT_PARSE_BASE): Promise<Response> => {
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'access-control-allow-origin': '*',
                'access-control-allow-methods': 'GET,OPTIONS',
                'access-control-allow-headers': '*',
            },
        });
    }
    if (url.pathname === '/api/soda/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json({ items: [], hasMore: false });
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50);
        const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
        return searchSoda(q, limit, offset);
    }
    if (url.pathname === '/api/soda/track') {
        const id = (url.searchParams.get('id') || '').trim();
        if (!/^\d+$/.test(id)) return errorJson('soda track id must be numeric', 400);
        return trackSoda(id, parseBase);
    }
    if (url.pathname === '/api/soda/qr') {
        return qrSoda();
    }
    if (url.pathname === '/api/soda/qr/status') {
        return qrStatusSoda(request);
    }
    if (url.pathname === '/api/soda/me') {
        return accountSoda('/luna/pc/me', (url.searchParams.get('sessionid') || '').trim());
    }
    if (url.pathname === '/api/soda/playlists') {
        return accountSoda('/luna/pc/me/playlist', (url.searchParams.get('sessionid') || '').trim());
    }
    return errorJson('unknown soda route', 404);
};
