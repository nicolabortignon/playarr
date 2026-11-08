import type { ReachabilityCheck, ReachabilityStatus, ReachabilityStep, ReachabilityVerdict } from '@playarr/shared';
import { useMutation } from '@tanstack/react-query';
import { Check, CircleAlert, CircleCheck, Minus, RotateCw, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { useServerInfo } from '../lib/queries';
import { Button } from './Button';
import { SettingsSection } from './SettingsControls';
import { InlineError } from './States';

/** How to give Playarr a public HTTPS address: Caddy with your own domain, or Tailscale without one. */
export const HTTPS_GUIDE = 'https://github.com/nicolabortignon/playarr/blob/main/docs/server/https.md';

const STEP: Record<ReachabilityStatus, { Icon: LucideIcon; tone: string; word: string }> = {
  ok: { Icon: Check, tone: 'text-success', word: 'passed' },
  warn: { Icon: TriangleAlert, tone: 'text-warning', word: 'not certain' },
  fail: { Icon: X, tone: 'text-danger', word: 'failed' },
  skipped: { Icon: Minus, tone: 'text-muted', word: 'not checked' },
};

const VERDICT: Record<ReachabilityVerdict, { Icon: LucideIcon; tone: string }> = {
  reachable: { Icon: CircleCheck, tone: 'text-success' },
  unreachable: { Icon: CircleAlert, tone: 'text-danger' },
  unconfirmed: { Icon: TriangleAlert, tone: 'text-warning' },
};

/**
 * Settings → Away from home (admins): is this server reachable from outside over HTTPS? The server asks its own public
 * address (PUBLIC_URL) the way a phone would, step by step, and says what to fix; the guide shows how to get one.
 */
export function AwayFromHomePanel() {
  const server = useServerInfo();
  const check = useMutation({ mutationFn: api.checkReachability });
  const result = check.data;
  const publicUrl = result ? result.publicUrl : server.data?.publicUrl;

  return (
    <div>
      <p className="mb-10 max-w-prose type-body text-paper-dim">
        Away from home, phones and computers reach Playarr at its public address, over HTTPS. The check asks that address
        from the server itself, the way a phone would, and says what to fix.
      </p>

      <SettingsSection title="Public address">
        {!result && server.isPending ? (
          <div aria-busy="true" aria-label="Loading" className="h-6 w-64 max-w-full animate-pulse rounded-lg bg-paper/5" />
        ) : (
          <p className={cn('type-body break-words', publicUrl ? 'text-paper' : 'text-muted')}>{publicUrl ?? 'Not set yet'}</p>
        )}
        <Button icon={<RotateCw />} onClick={() => check.mutate()} pending={check.isPending} pendingLabel="Checking…" className="mt-4">
          Check now
        </Button>
        {check.error && <InlineError error={check.error} className="mt-4">Couldn’t check</InlineError>}
      </SettingsSection>

      <SettingsSection title="Reachable from outside over HTTPS?">
        <Verdict check={result} />
        {result && <Steps check={result} />}
      </SettingsSection>

      <SettingsSection title="Setting it up">
        <p className="type-body text-paper-dim">
          Two ways: Caddy with a domain of your own, or Tailscale without one.{' '}
          <a href={HTTPS_GUIDE} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            Read the guide
          </a>
        </p>
      </SettingsSection>
    </div>
  );
}

/** The verdict in a sentence: the one line read out when a check ends (the steps are there to read on). */
function Verdict({ check }: { check: ReachabilityCheck | undefined }) {
  const { Icon, tone } = check ? (VERDICT[check.verdict] ?? VERDICT.unreachable) : { Icon: undefined, tone: 'text-muted' };
  return (
    <p role="status" className={cn('flex items-start gap-2 type-body', tone)}>
      {Icon && <Icon aria-hidden className="mt-0.5 size-4.5 shrink-0" />}
      <span className="min-w-0 break-words">{check?.summary ?? 'Not checked yet.'}</span>
    </p>
  );
}

function Steps({ check }: { check: ReachabilityCheck }) {
  const at = new Date(check.checkedAt);
  return (
    <>
      <ol aria-label="Steps" className="mt-6 space-y-4">
        {check.steps.map((step) => (
          <Step key={step.id} step={step} />
        ))}
      </ol>
      <p className="mt-6 type-meta text-muted">
        Checked <time dateTime={check.checkedAt}>{at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
      </p>
    </>
  );
}

function Step({ step }: { step: ReachabilityStep }) {
  const { Icon, tone, word } = STEP[step.status] ?? STEP.skipped;
  return (
    <li className="flex gap-3">
      <Icon aria-hidden className={cn('mt-0.5 size-4.5 shrink-0', tone)} />
      <div className="min-w-0">
        <p className={cn('type-body', step.status === 'skipped' ? 'text-muted' : 'text-paper')}>
          {step.label}
          <span className="sr-only">: {word}</span>
        </p>
        {step.detail && <p className="mt-0.5 type-small break-words text-paper-dim">{step.detail}</p>}
        {step.fix && <p className="mt-1 type-small break-words text-muted">{step.fix}</p>}
      </div>
    </li>
  );
}
