import { OnlineProviderError } from '../../types/onlineMusic';
import type { AudioQualityPreference, ProviderCollection, ProviderPage, ProviderUser } from '../../types/onlineMusic';
import type { UnifiedSong } from '../../types';
import {
    getSodaTransportAvailability,
    requestSodaMe,
    requestSodaPlaylists,
    requestSodaQr,
    requestSodaQrStatus,
    requestSodaSearch,
    requestSodaTrack,
} from './sodaTransport';
import { readProviderSessionValue, removeProviderSessionValue, writeProviderSessionValue } from './providerStorage';

// src/services/onlineMusic/sodaProvider.ts
// 汽水音乐（字节）的 provider：搜索、播放、扫码登录（抖音 App 扫码）与账号歌单。
// 搜索/播放/扫码请求全部由 Worker 的 /api/soda/* 完成；前端只保存登录后的 sessionid。

const SESSIONID_KEY = 'sessionid';
/** 二维码会话的临时缓存：token → { 图片, 创建时的 Cookie }。 */
const qrSessions = new Map<string, { image: string; cookie: string }>();

const durationOf = (raw: Record<string, unknown>): number => Math.max(0, Number(raw.durationMs) || 0);

/** 把 Worker 归一化过的搜索结果映射成 UnifiedSong。 */
export const normalizeSodaSong = (raw: unknown): UnifiedSong => {
    const item = (raw || {}) as Record<string, unknown>;
    const id = String(item.id || '').trim();
    if (!id) throw new OnlineProviderError('invalid-response', 'Soda track has no id', 'soda');
    return {
        id,
        name: String(item.title || ''),
        artists: [{ id: '', name: String(item.artist || '') }],
        album: {
            id: String(item.album || ''),
            name: String(item.album || ''),
            coverUrl: String(item.cover || ''),
        },
        durationMs: durationOf(item),
        sourceRef: { kind: 'online', providerId: 'soda', mediaId: id, providerData: {} },
    };
};

const pageOf = (items: UnifiedSong[], total: number | undefined, offset: number, limit: number, hasMore?: boolean) => ({
    items,
    total,
    hasMore: typeof hasMore === 'boolean' ? hasMore : items.length >= limit,
    nextOffset: offset + items.length,
});

const recordOf = (value: unknown): Record<string, any> => (value && typeof value === 'object' ? value as Record<string, any> : {});

/** 账号信息在不同上游版本里字段名不一样，这里做一次兜底取值。 */
export const normalizeSodaUser = (raw: unknown): ProviderUser => {
    const root = recordOf(raw);
    const profile = recordOf(root.profile ?? root.user ?? root.data ?? root);
    const avatar = recordOf(profile.avatar_url ?? profile.avatarUrl ?? profile.avatar);
    return {
        id: String(profile.uid ?? profile.user_id ?? profile.id ?? 'soda'),
        nickname: String(profile.nickname ?? profile.name ?? '汽水账号'),
        avatarUrl: String(profile.avatar_url ?? profile.avatarUrl ?? (Array.isArray(avatar.urls) ? avatar.urls[0] : '') ?? ''),
    };
};

const coverOf = (raw: unknown): string => {
    const cover = recordOf(raw);
    if (Array.isArray(cover.urls) && cover.uri) {
        const prefix = cover.template_prefix ? `~${cover.template_prefix}.jpeg` : '';
        return `${cover.urls[0]}${cover.uri}${prefix}`;
    }
    return String(cover.url ?? cover.uri ?? '');
};

const normalizeSodaCollection = (raw: unknown): ProviderCollection => {
    const item = recordOf(raw);
    const id = String(item.id ?? item.playlist_id ?? '');
    return {
        providerId: 'soda',
        id,
        name: String(item.name ?? item.title ?? '未命名歌单'),
        type: 'playlist',
        coverUrl: coverOf(item.cover ?? item.cover_url ?? item.pic),
        description: String(item.description ?? item.desc ?? ''),
        trackCount: Number(item.track_count ?? item.trackCount ?? 0) || 0,
        providerData: {},
    };
};

/** 从 Worker 的歌单响应里取出数组（上游字段名不固定）。 */
const playlistListOf = (raw: unknown): unknown[] => {
    const root = recordOf(raw);
    const data = recordOf(root.data ?? root);
    const list = data.playlists ?? root.playlists ?? data.list ?? root.list;
    return Array.isArray(list) ? list : [];
};

const sessionId = (): string => String(readProviderSessionValue('soda', SESSIONID_KEY) || '');

export const sodaProvider: OnlineMusicProvider = {
    id: 'soda',
    displayName: '汽水音乐',
    shortName: '汽水',
    getAvailability: getSodaTransportAvailability,
    capabilities: {
        search: true,
        playback: true,
        lyrics: false,
        // 汽水的扫码登录走抖音 SDK 深链，浏览器/抖音打开都是 404，等于不可用；
        // 这里先退回「无账户」：选平台直接进，不弹登录，避免用户被死链二维码卡住。
        auth: false,
    },
    normalizeSong: normalizeSodaSong,
    normalizeUser: normalizeSodaUser,
    search: {
        async searchSongs(query, limit, offset) {
            if (!query.trim()) return pageOf([], 0, offset, limit, false);
            const result = await requestSodaSearch(query, limit, offset);
            const items = Array.isArray(result.items) ? result.items.map(normalizeSodaSong) : [];
            return pageOf(items, result.total, offset, limit, result.hasMore);
        },
    },
    playback: {
        async getSongDetail(id) {
            return normalizeSodaSong({ id });
        },
        async getAudioSource(song, quality) {
            const source = song.sourceRef;
            if (source?.kind !== 'online' || source.providerId !== 'soda') {
                throw new OnlineProviderError('unsupported', 'Song does not belong to Soda Music', 'soda');
            }
            const track = await requestSodaTrack(String(source.mediaId));
            if (!track?.url) {
                throw new OnlineProviderError('not-playable', 'Soda returned no playable url', 'soda');
            }
            return {
                url: track.url,
                fetchedAt: Date.now(),
                quality: quality as AudioQualityPreference,
            };
        },
        getAvailability() {
            return { state: 'unknown' as const };
        },
    },
    library: {
        async getUserPlaylists(userId, limit, offset) {
            const sid = sessionId();
            if (!sid) return { items: [], hasMore: false, nextOffset: offset } as ProviderPage<ProviderCollection>;
            const raw = await requestSodaPlaylists(sid);
            const items = playlistListOf(raw).map(normalizeSodaCollection).filter(item => item.id);
            return {
                items: items.slice(offset, offset + limit),
                total: items.length,
                hasMore: offset + limit < items.length,
                nextOffset: offset + Math.min(limit, items.length),
            };
        },
    },
    auth: {
        async getLoginStatus() {
            const sid = sessionId();
            if (!sid) return null;
            try {
                return normalizeSodaUser(await requestSodaMe(sid));
            } catch {
                // sessionid 失效就直接清掉，让界面回到未登录。
                removeProviderSessionValue('soda', SESSIONID_KEY);
                return null;
            }
        },
        async logout() {
            removeProviderSessionValue('soda', SESSIONID_KEY);
            qrSessions.clear();
        },
        async getQrKey() {
            const qr = await requestSodaQr();
            qrSessions.set(qr.token, { image: qr.qrImage, cookie: qr.cookie });
            return qr.token;
        },
        async createQr(key) {
            const cached = qrSessions.get(key);
            if (cached) return cached.image;
            const qr = await requestSodaQr();
            qrSessions.set(qr.token, { image: qr.qrImage, cookie: qr.cookie });
            return qr.qrImage;
        },
        async checkQr(key) {
            const cached = qrSessions.get(key);
            const result = await requestSodaQrStatus(key, cached?.cookie || '');
            const status = String(result.status || '');
            if (status === 'confirmed' && result.sessionid) {
                writeProviderSessionValue('soda', SESSIONID_KEY, result.sessionid);
                qrSessions.delete(key);
                return { state: 'confirmed' };
            }
            if (status === 'new') return { state: 'waiting' };
            if (status === 'scanned') return { state: 'scanned' };
            if (status === 'expired') return { state: 'expired' };
            return { state: 'error', message: status || 'unknown' };
        },
    },
};
