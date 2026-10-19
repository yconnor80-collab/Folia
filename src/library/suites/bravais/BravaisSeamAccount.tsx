import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, RotateCcw, ServerCog, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BravaisAccountForm, BravaisConfirmForm, BravaisLoginForm } from './bravaisAccountModel';
import { setBravaisAccountElement, useBravaisAccountStore, type BravaisAccountActions } from './bravaisAccountStore';
import type { BravaisAccountSeamVariant } from './bravaisSeamTarget';
import BravaisLoginFailureHelpView from './BravaisLoginFailureHelp';
import { BravaisSeamFlip, BravaisSeamFlipText } from './BravaisSeamFlip';
import { kugouProvider } from '../../../services/onlineMusic/kugouProvider';
import qqIcon from '../../../assets/providers/qq.svg';
import wechatIcon from '../../../assets/providers/wechat.svg';
import './bravaisAccount.css';

// src/library/suites/bravais/BravaisSeamAccount.tsx
// 缝里的账户表单态（B10，设计稿 §10.7、§10.1「表单态」）：不弹浮层，缝原地翻成
// - 登录态（account-login / account-login-method）：标题与关闭、QQ 式多方式时先选方式（不要码）、200px 的二维码位
//   （二维码 / 要码中 / 选方式的占位 / 网易后端故障的原因）、状态行、重试（冷却时禁用并显示秒数）或重启后端、
//   失败后的帮助（account-login-diagnostics：简单办法 → 自检 → 收起的诊断与反馈，BravaisLoginFailureHelp）、provider 的说明；
// - 确认态（account-switch-confirm）：「切换 / 取消」，确认按钮拿到焦点。答复后立即翻回（不等 confirmSwitch 的事务）。
// 表单数据与动作来自 bravaisAccountStore（account surface 投影好的）；按键由 account surface 的独占监听处理，这里的
// 按钮给鼠标与原生 Enter / 空格用。翻出去的那半圈（已答复 / 已关掉）仍画最后一份同类的表单，但对读屏与指针都藏起来，
// 不在纸上留白，也不会被当成还开着的登录界面。
// 表单里：二维码位换了形态（要码中 → 二维码 → 后端故障…）像磁贴一样翻一次，状态行换了字新的一行翻进来（BravaisSeamFlip）。

// provider 只声明 iconKey 字符串，静态资源的映射留在 UI 层（与 grid 的登录弹窗同一份图）。
const LOGIN_METHOD_ICONS: Record<string, string> = {
    qq: qqIcon,
    wechat: wechatIcon,
};

/** 二维码位翻牌的那一格：在表单的竖排里居中（二维码位自己的 align-self 在这一格里不再起作用）。 */
const QR_FACE_STYLE: React.CSSProperties = { alignSelf: 'center', flex: 'none' };

const LoginQr: React.FC<{ qr: BravaisLoginForm['qr'] }> = ({ qr }) => (
    <div className={`bravais-login-qr is-${qr.kind}`} data-bravais-login-qr={qr.kind}>
        {qr.kind === 'image' && <img src={qr.url} alt="QR Code" width={200} height={200} />}
        {qr.kind === 'loading' && <Loader2 aria-hidden className="animate-spin" />}
        {qr.kind === 'choose-method' && <span>{qr.text}</span>}
        {qr.kind === 'backend-failure' && (
            <div className="bravais-login-backend" data-bravais-login-backend>
                <AlertTriangle aria-hidden />
                <p className="is-title">{qr.title}</p>
                {qr.detail && <p className="is-detail">{qr.detail}</p>}
            </div>
        )}
    </div>
);

// 酷狗的第二条登录通道（手机号 + 验证码），画在二维码下面。扫码流程与它互不影响：
// 只在 provider 是 kugou 时渲染，成功后关掉表单并刷新一次页面让账号状态重新拉取。
const KugouPhoneLogin: React.FC<{ onDone: () => void }> = ({ onDone }) => {
    const [mobile, setMobile] = useState('');
    const [code, setCode] = useState('');
    const [sending, setSending] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [cooldown, setCooldown] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [sent, setSent] = useState(false);

    useEffect(() => {
        if (cooldown <= 0) return undefined;
        const timer = window.setTimeout(() => setCooldown(value => value - 1), 1000);
        return () => window.clearTimeout(timer);
    }, [cooldown]);

    const mobileValid = /^1\d{10}$/.test(mobile.trim());
    const canSend = mobileValid && !sending && cooldown === 0;
    const canSubmit = mobileValid && code.trim().length > 0 && !submitting;

    const handleSend = async () => {
        if (!canSend) return;
        setError(null);
        setSending(true);
        try {
            await kugouProvider.auth?.sendLoginCode?.(mobile.trim());
            setSent(true);
            setCooldown(60);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSending(false);
        }
    };

    const handleSubmit = async () => {
        if (!canSubmit) return;
        setError(null);
        setSubmitting(true);
        try {
            await kugouProvider.auth?.loginWithPhone?.(mobile.trim(), code.trim());
            onDone();
            window.setTimeout(() => window.location.reload(), 600);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setSubmitting(false);
        }
    };

    const inputStyle: React.CSSProperties = {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,.16)',
        background: 'rgba(255,255,255,.06)',
        color: 'inherit',
        fontSize: 13,
        outline: 'none',
    };
    const buttonStyle: React.CSSProperties = {
        padding: '8px 12px',
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,.16)',
        background: 'rgba(255,255,255,.08)',
        color: 'inherit',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
    };

    return (
        <div style={{ width: '100%', marginTop: 12 }} data-bravais-kugou-phone>
            <p style={{ margin: '0 0 8px', fontSize: 11, opacity: 0.55, textAlign: 'center', letterSpacing: '.08em' }}>
                或 手机号登录
            </p>
            <input
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                value={mobile}
                onChange={event => setMobile(event.target.value.replace(/\D/g, '').slice(0, 11))}
                placeholder="手机号"
                style={inputStyle}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))}
                    placeholder="验证码"
                    style={{ ...inputStyle, minWidth: 0, flex: 1 }}
                />
                <button type="button" onClick={() => void handleSend()} disabled={!canSend} style={{ ...buttonStyle, opacity: canSend ? 1 : 0.45 }}>
                    {sending ? '发送中…' : cooldown > 0 ? `${cooldown}s` : '发送验证码'}
                </button>
            </div>
            <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                style={{ ...buttonStyle, marginTop: 8, width: '100%', opacity: canSubmit ? 1 : 0.45 }}
            >
                {submitting ? '登录中…' : '登录'}
            </button>
            {(error || sent) && (
                <p style={{ margin: '6px 0 0', fontSize: 11, lineHeight: 1.4, color: error ? '#f87171' : '#4ade80' }}>
                    {error || '验证码已发送，请查看手机短信'}
                </p>
            )}
        </div>
    );
};

const LoginView: React.FC<{ form: BravaisLoginForm; actions: BravaisAccountActions; live: boolean }> = ({ form, actions, live }) => {    const { t } = useTranslation();
    const rootRef = useRef<HTMLElement | null>(null);
    const setRoot = useCallback((element: HTMLElement | null) => {
        rootRef.current = element;
        setBravaisAccountElement(element);
    }, []);
    // 显示出来时把焦点拿进表单：首页上开着的输入框不该继续接收按键（独占监听另外截住了按键）。
    useEffect(() => {
        if (live && useBravaisAccountStore.getState().isInteractive) rootRef.current?.focus({ preventScroll: true });
    }, [live, form.providerId]);
    const { methods, retry, restart } = form;
    return (
        <section
            ref={setRoot}
            role="dialog"
            aria-label={form.title}
            aria-hidden={live ? undefined : true}
            inert={!live}
            tabIndex={-1}
            className="bravais-seam-form bravais-account-form is-login"
            data-bravais-account-login={form.providerId}
            data-bravais-login-phase={form.phase}
        >
            <div className="bravais-account-head">
                <h2 className="bravais-form-title">{form.title}</h2>
                <button type="button" className="bravais-seam-icon" data-bravais-form-action="close"
                    aria-label={form.closeLabel} title={form.closeLabel} onClick={actions.close}>
                    <X aria-hidden />
                </button>
            </div>
            {methods && (
                <div className="bravais-login-methods" data-bravais-login-methods>
                    <p className="is-label">{methods.title}</p>
                    <p className="is-hint">{methods.hint}</p>
                    <div className="bravais-login-method-options">
                        {methods.options.map(option => (
                            <button
                                key={option.id}
                                type="button"
                                aria-pressed={option.selected}
                                data-bravais-login-method={option.id}
                                className={option.selected ? 'is-selected' : undefined}
                                onClick={() => actions.selectMethod(option.id)}
                            >
                                {LOGIN_METHOD_ICONS[option.iconKey] && <img src={LOGIN_METHOD_ICONS[option.iconKey]} alt="" aria-hidden />}
                                <span>{option.label}</span>
                                {option.selected && <Check aria-hidden />}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            <BravaisSeamFlip flipKey={form.qr.kind} style={QR_FACE_STYLE}>
                <LoginQr qr={form.qr} />
            </BravaisSeamFlip>
            {form.providerId === 'kugou' && <KugouPhoneLogin onDone={actions.close} />}
            {methods?.current && <p className="bravais-login-current">{methods.current}</p>}
            {form.status && (
                <BravaisSeamFlipText as="p" flipKey={form.status} className={`bravais-login-status is-${form.tone}`} data-bravais-login-status>
                    {form.status}
                </BravaisSeamFlipText>
            )}
            {(restart || retry) && (
                <span className="bravais-form-buttons">
                    {restart && (
                        <button type="button" className="bravais-chrome-button is-primary" data-bravais-form-action="restart"
                            disabled={restart.restarting} onClick={actions.restart}>
                            {restart.restarting ? <Loader2 aria-hidden className="animate-spin" /> : <ServerCog aria-hidden />}
                            {restart.label}
                        </button>
                    )}
                    {retry && (
                        <button type="button" className="bravais-chrome-button is-primary" data-bravais-form-action="retry"
                            disabled={retry.disabled} onClick={actions.retry}>
                            <RotateCcw aria-hidden />{retry.label}
                            {retry.cooldownSeconds !== null && (
                                <span className="bravais-login-cooldown" data-bravais-login-cooldown={retry.cooldownSeconds}>
                                    {t('libraryBravaisAccount.cooldown', { seconds: retry.cooldownSeconds })}
                                </span>
                            )}
                        </button>
                    )}
                </span>
            )}
            {form.failureHelp && (
                // 按会话代次换实例：重试后的下一次失败重新收起，复制的反馈也只属于这一轮。
                <BravaisLoginFailureHelpView key={form.sessionId} help={form.failureHelp} providerId={form.providerId} actions={actions} />
            )}
            <p className="bravais-login-note">{form.note}</p>
        </section>
    );
};

const ConfirmView: React.FC<{ form: BravaisConfirmForm; actions: BravaisAccountActions; live: boolean }> = ({ form, actions, live }) => {
    const confirmRef = useRef<HTMLButtonElement>(null);
    // 确认按钮拿到焦点：Enter 原生激活它（独占监听把自己按钮上的 Enter 交还给按钮）。
    useEffect(() => {
        if (live && useBravaisAccountStore.getState().isInteractive) confirmRef.current?.focus({ preventScroll: true });
    }, [form.requestId, live]);
    return (
        <section
            ref={setBravaisAccountElement}
            role="alertdialog"
            aria-label={form.title}
            aria-hidden={live ? undefined : true}
            inert={!live}
            className="bravais-seam-form bravais-account-form is-confirm"
            data-bravais-account-confirm={form.providerId}
            data-bravais-confirm-reason={form.reason}
        >
            <h2 className="bravais-form-title">{form.title}</h2>
            <p className="bravais-form-message" data-bravais-confirm-message>{form.description}</p>
            <span className="bravais-form-buttons">
                <button ref={confirmRef} type="button" className="bravais-chrome-button is-primary" data-bravais-form-action="confirm"
                    onClick={() => actions.confirm(form.requestId)}>
                    {form.confirmLabel}
                </button>
                <button type="button" className="bravais-chrome-button" data-bravais-form-action="cancel"
                    onClick={() => actions.cancel(form.requestId)}>
                    {form.cancelLabel}
                </button>
            </span>
        </section>
    );
};

/** 缝的 login / confirm 变体：画 store 里此刻的表单；表单已经换走时画最后一份同类的（翻出去的半圈）。 */
const BravaisSeamAccount: React.FC<{ variant: BravaisAccountSeamVariant }> = ({ variant }) => {
    const form = useBravaisAccountStore(state => state.form);
    const actions = useBravaisAccountStore(state => state.actions);
    const lastRef = useRef<BravaisAccountForm | null>(null);
    if (form?.kind === variant) lastRef.current = form;
    const shown = lastRef.current?.kind === variant ? lastRef.current : null;
    if (!shown || !actions) return null;
    const live = shown === form;
    return shown.kind === 'login'
        ? <LoginView form={shown} actions={actions} live={live} />
        : <ConfirmView form={shown} actions={actions} live={live} />;
};

export default BravaisSeamAccount;
