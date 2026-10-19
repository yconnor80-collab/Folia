// worker/soda.ts
// 汽水音乐（字节）的同源反代。浏览器只调 /api/soda/*，这里负责：
//   /api/soda/search?q=&limit=&offset=  匿名搜索（api.qishui.com/luna/search/track）
//   /api/soda/track?id=                 取播放直链（第三方解析服务，请求体 AES-256-GCM 加密）
// 说明：汽水没有公开 API。搜索靠一套 Android 设备参数匿名可用；播放直链官方接口匿名会返回空 body，
// 所以走社区解析服务（SODA_PARSE_BASE 可换）。两者都可能随时失效，失败时返回可读的 JSON 错误。

const SEARCH_URL = 'https://api.qishui.com/luna/search/track';
const DEFAULT_PARSE_BASE = 'https://qiuyu520.fun/qishuiParse';
// 解析请求体的 AES-256-GCM 密钥（来自社区实现，社区改版时这里也要跟着换）。
const PARSE_KEY_HEX = 'bf0e991833b2bdfc27f621f01b9a65348f3e89484362cdcc77e6d1606b4a3584';

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
    return errorJson('unknown soda route', 404);
};
