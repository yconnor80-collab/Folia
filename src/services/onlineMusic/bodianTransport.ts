import { OnlineProviderError } from '../../types/onlineMusic';
import type { BodianOperation, BodianParams, BodianResult } from 'bodian-music-api';
import { toBodianProviderError } from './bodianErrors';
import { readProviderSessionValue, removeProviderSessionValue, writeProviderSessionValue } from './providerStorage';

// src/services/onlineMusic/bodianTransport.ts
// 波点音乐的请求边界：桌面版走 Electron 主进程的 bodian-music-api；网页/App 没有那个桥，
// 改走同源 Worker 反代 /api/bodian（协议与桌面版一致，见 worker/bodian.ts）。
// 会话（uid/token/user）由前端保存，每次请求带过去；Worker 不存凭据。

export type { BodianOperation, BodianParams } from 'bodian-music-api';
export type BodianBridgeResult = BodianResult;

const SESSION_KEY = 'session';

type BodianSession = {
    uid: string;
    token: string;
    user?: { id: string; nickname: string; avatarUrl: string };
};

let memorySession: BodianSession | null = null;

/** 最近一次失败的调用（操作名 + 错误原文），登录后账号刷新失败时进诊断报告。 */
type BodianFailure = { at: number; operation: string; message: string };
const recentFailures: BodianFailure[] = [];
/** 供 provider 记录非 transport 路径的失败（例如歌单归一化抛错）。 */
export const recordBodianFailure = (operation: string, error: unknown): void => noteFailure(operation, error);

const noteFailure = (operation: string, error: unknown): void => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    recentFailures.push({ at: Date.now(), operation, message: message.slice(0, 240) });
    if (recentFailures.length > 8) recentFailures.shift();
};

/** 诊断用：会话是否存在、最近的失败记录。 */
export const describeBodianState = (): string[] => {
    const session = readSession();
    const lines = [
        `session: ${session ? `uid ${session.uid}, token ${session.token ? 'present' : 'missing'}` : 'none'}`,
    ];
    if (!recentFailures.length) lines.push('recent failures: none');
    for (const item of recentFailures.slice(-5)) {
        const clock = new Date(item.at).toISOString().slice(11, 19);
        lines.push(`failure ${clock} ${item.operation}: ${item.message}`);
    }
    return lines;
};

/** 每个客户端自己的 32 位设备 ID：波点登录态与它绑定，共用会导致扫码会话串号。 */
const deviceId = (): string => {
    const stored = readProviderSessionValue('bodian', 'deviceId');
    if (stored && /^[a-f0-9]{32}$/.test(stored)) return stored;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
    writeProviderSessionValue('bodian', 'deviceId', id);
    return id;
};

const readSession = (): BodianSession | null => {
    if (memorySession) return memorySession;
    const raw = readProviderSessionValue('bodian', SESSION_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as BodianSession;
        return parsed?.uid && parsed?.token ? parsed : null;
    } catch {
        return null;
    }
};

const writeSession = (session: BodianSession): void => {
    memorySession = session;
    writeProviderSessionValue('bodian', SESSION_KEY, JSON.stringify(session));
};

const clearSession = (): void => {
    memorySession = null;
    removeProviderSessionValue('bodian', SESSION_KEY);
};

const hasDesktopBridge = (): boolean => (
    typeof window !== 'undefined' && typeof window.electron?.bodianRequest === 'function'
);

export const getBodianTransportAvailability = () => ({ configured: true } as const);

const operationForHttp = (operation: BodianOperation): string => {
    switch (operation) {
        case 'login_qr_key': return 'qr_key';
        case 'login_qr_check': return 'qr_check';
        case 'user_playlists': return 'playlists';
        case 'song_detail': return 'song_detail';
        default: return operation;
    }
};

/** 把 provider 的参数翻译成 Worker 能认的 query（Worker 只认我们列出的字段）。 */
const toHttpQuery = (operation: BodianOperation, params: BodianParams, session: BodianSession | null): URLSearchParams => {
    const query = new URLSearchParams({
        op: operationForHttp(operation),
        uid: session?.uid || '-1',
        token: session?.token || '',
        dev: deviceId(),
    });
    const set = (key: string, value: unknown) => {
        if (value === undefined || value === null || value === '') return;
        query.set(key, String(value));
    };
    set('query', params.query);
    set('id', params.id ?? params.key);
    set('limit', params.limit);
    set('offset', params.offset);
    set('quality', params.quality);
    set('freeSign', params.freeSign);
    return query;
};

/**
 * 网页模式的二维码：交给 Worker 生成（qrcode 的矩阵 + SVG，不依赖 canvas/pngjs），
 * 前端只把返回的 data URI 直接塞进 <img src>。
 */
const createQrImage = async (key: string): Promise<string> => {
    const response = await fetch(`/api/bodian?op=qr_create&key=${encodeURIComponent(key)}`, { credentials: 'include' });
    if (!response.ok) {
        throw new OnlineProviderError('network', `Bodian QR failed with ${response.status}`, 'bodian');
    }
    const body = await response.json() as { imageUrl?: string };
    if (!body?.imageUrl) throw new OnlineProviderError('invalid-response', 'Bodian QR image is missing', 'bodian');
    return body.imageUrl;
};

export async function requestBodian<T = unknown>(operation: BodianOperation, params: BodianParams = {}): Promise<T> {
    if (hasDesktopBridge()) {
        let result: BodianBridgeResult;
        const boundedParams = Number.isSafeInteger(params.limit) && Number(params.limit) > 100
            ? { ...params, limit: 100 } : params;
        try {
            result = await window.electron!.bodianRequest(operation, boundedParams);
        } catch (error) {
            throw new OnlineProviderError('unavailable', 'Bodian desktop request failed', 'bodian',
                error, undefined, undefined, { stage: 'ipc' });
        }
        if (!result.ok) throw toBodianProviderError(result.error);
        return result.data as T;
    }

    // ── 网页 / App：走同源 Worker ───────────────────────────────────────
    if (operation === 'login_qr_create') {
        const key = String(params.key || '');
        if (!key) throw new OnlineProviderError('invalid-response', 'Bodian QR key is missing', 'bodian');
        return { imageUrl: await createQrImage(key) } as T;
    }
    if (operation === 'login_status') {
        const session = readSession();
        if (!session) { noteFailure('login_status', 'no stored session'); return null as T; }
        // 有的上游响应只给 uid/token；没有昵称时用占位身份，避免控制器把登录判成失败。
        return (session.user || { id: session.uid, nickname: '波点账号', avatarUrl: '' }) as T;
    }
    if (operation === 'logout') {
        clearSession();
        return null as T;
    }

    const session = readSession();
    const query = toHttpQuery(operation, params, session);

    let response: Response;
    try {
        response = await fetch(`/api/bodian?${query}`, { credentials: 'include' });
    } catch (error) {
        noteFailure(operation, error);
        throw new OnlineProviderError('network', `Bodian API ${operation} unreachable`, 'bodian', error);
    }

    let body: any;
    try {
        body = await response.json();
    } catch {
        throw new OnlineProviderError('invalid-response', `Bodian API ${operation} returned an unreadable body`, 'bodian');
    }
    if (!response.ok) {
        noteFailure(operation, body?.error || `HTTP ${response.status}`);
        throw new OnlineProviderError('network', String(body?.error || `Bodian API ${operation} failed`), 'bodian');
    }

    if (operation === 'login_qr_check' && body?.state === 'confirmed' && body?.session?.uid && body?.session?.token) {
        writeSession({ uid: String(body.session.uid), token: String(body.session.token), user: body.user });
        return { state: 'confirmed' } as T;
    }
    return body as T;
}
