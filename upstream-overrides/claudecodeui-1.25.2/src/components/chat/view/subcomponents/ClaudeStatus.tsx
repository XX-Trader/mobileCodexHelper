import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../../lib/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

type ClaudeStatusProps = {
  status: {
    text?: string;
    tokens?: number;
    can_interrupt?: boolean;
  } | null;
  onAbort?: () => void;
  isLoading: boolean;
  provider?: string;
};

const PROVIDER_LABEL_KEYS: Record<string, string> = {
  claude: 'messageTypes.claude',
  codex: 'messageTypes.codex',
  cursor: 'messageTypes.cursor',
  gemini: 'messageTypes.gemini',
};

function formatElapsedTime(totalSeconds: number, t: (key: string, options?: Record<string, unknown>) => string) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 1) {
    return t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' });
  }

  return t('claudeStatus.elapsed.minutesSeconds', {
    minutes,
    seconds,
    defaultValue: '{{minutes}}m {{seconds}}s',
  });
}

/**
 * 渲染会话回答中的状态条，并在可中断时提供停止按钮。
 *
 * @param props.status 当前会话的状态文本与中断能力；可为空。
 * @param props.onAbort 用户请求停止当前回答时触发的回调。
 * @param props.isLoading 是否仍在回答中；为 `true` 时显示动态状态。
 * @param props.provider 当前会话所属提供方标识。
 * @returns 紧凑的状态展示条；无状态且未加载时返回 `null`。
 * @throws 不直接抛出异常；渲染错误交由上层 React 错误边界处理。
 */
export default function ClaudeStatus({
  status,
  onAbort,
  isLoading,
  provider = 'claude',
}: ClaudeStatusProps) {
  const { t } = useTranslation('chat');
  const [elapsedTime, setElapsedTime] = useState(0);

  useEffect(() => {
    if (!isLoading) {
      setElapsedTime(0);
      return;
    }

    const startTime = Date.now();

    const timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      setElapsedTime(elapsed);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [isLoading]);

  // Note: showThinking only controls the reasoning accordion in messages, not this processing indicator
  if (!isLoading && !status) {
    return null;
  }

  const statusText = status?.text || t('claudeStatus.actions.processing', { defaultValue: 'Processing' });
  const cleanStatusText = statusText.replace(/[.]+$/, '');
  const canInterrupt = isLoading && status?.can_interrupt !== false;
  const providerLabelKey = PROVIDER_LABEL_KEYS[provider];
  const providerLabel = providerLabelKey
    ? t(providerLabelKey)
    : t('claudeStatus.providers.assistant', { defaultValue: 'Assistant' });
  const elapsedLabel = elapsedTime > 0 ? formatElapsedTime(elapsedTime, t) : '0s';

  return (
    <div className="animate-in slide-in-from-bottom mb-2 w-full duration-300 sm:mb-4">
      <div className="relative mx-auto min-h-[5.25rem] max-w-4xl overflow-hidden rounded-xl border border-border/70 bg-card/90 shadow-sm backdrop-blur-md sm:min-h-[6rem] sm:rounded-2xl sm:shadow-md">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-primary/10 via-transparent to-sky-500/10 dark:from-primary/20 dark:to-sky-400/20" />

        <div className="relative px-2.5 py-2 sm:px-4 sm:py-3.5">
          <div className="flex min-h-[4rem] items-center justify-between gap-2.5 sm:min-h-[4.5rem] sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:items-start sm:gap-3" role="status" aria-live="polite">
              <div className="relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 sm:mt-0.5 sm:h-9 sm:w-9 sm:rounded-xl">
                <SessionProviderLogo provider={provider} className="h-4 w-4 sm:h-5 sm:w-5" />
                <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
                  {isLoading && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
                  )}
                  <span
                    className={cn(
                      'relative inline-flex h-2.5 w-2.5 rounded-full',
                      isLoading ? 'bg-emerald-400' : 'bg-amber-400',
                    )}
                  />
                </span>
              </div>

              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex min-h-[1rem] items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground sm:gap-2 sm:text-[10px] sm:tracking-[0.15em]">
                  <span>{providerLabel}</span>
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-0.5 text-[8px] tracking-[0.12em] sm:px-2 sm:text-[9px] sm:tracking-[0.14em]',
                      isLoading
                        ? 'bg-emerald-500/15 text-emerald-500 dark:text-emerald-400'
                        : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
                    )}
                  >
                    {isLoading
                      ? t('claudeStatus.state.live', { defaultValue: 'Live' })
                      : t('claudeStatus.state.paused', { defaultValue: 'Paused' })}
                  </span>
                </div>

                <p className="truncate whitespace-nowrap text-[13px] font-semibold leading-5 text-foreground sm:text-[15px]">
                  {cleanStatusText}
                  {isLoading && (
                    <span aria-hidden="true" className="ml-0.5 inline-flex w-[1.5rem] justify-start text-primary">
                      <span className="animate-pulse">...</span>
                    </span>
                  )}
                </p>

                <div className="mt-1 flex min-h-[1.5rem] items-center gap-1 text-[10px] text-muted-foreground sm:gap-1.5 sm:text-xs">
                  <span
                    aria-hidden="true"
                    className="inline-flex min-w-[3.75rem] items-center justify-center rounded-full border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono tabular-nums whitespace-nowrap sm:-ml-2 sm:min-w-[4.5rem] sm:px-2"
                  >
                    {elapsedLabel}
                  </span>
                </div>
              </div>
            </div>

            {canInterrupt && onAbort && (
              <div className="flex flex-shrink-0 items-center sm:w-auto sm:text-right">
                <button
                  type="button"
                  onClick={onAbort}
                  aria-label={t('claudeStatus.controls.stopGeneration', { defaultValue: 'Stop Generation' })}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-destructive px-2.5 text-xs font-semibold text-destructive-foreground shadow-sm ring-1 ring-destructive/40 transition-opacity hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/70 active:opacity-90 sm:h-auto sm:gap-2 sm:rounded-xl sm:px-3.5 sm:py-2 sm:text-sm"
                >
                  <svg className="h-3.5 w-3.5 sm:h-3.5 sm:w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  <span className="hidden sm:inline">{t('claudeStatus.controls.stopGeneration', { defaultValue: 'Stop Generation' })}</span>
                  <span className="hidden rounded-md bg-black/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-destructive-foreground/95 sm:inline-flex">
                    Esc
                  </span>
                </button>

                <p className="mt-1 hidden text-[11px] text-muted-foreground sm:block">
                  {t('claudeStatus.controls.pressEscToStop', { defaultValue: 'Press Esc anytime to stop' })}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
