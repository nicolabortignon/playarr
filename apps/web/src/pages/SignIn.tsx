import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button } from '../components/Button';
import { Wordmark } from '../components/Nav';
import { InlineError } from '../components/States';
import { TextField } from '../components/TextField';
import { deviceName, signedIn, switchTo, useAccounts } from '../lib/accounts';
import type { SignInResponse } from '@playarr/shared';
import { api, ApiError } from '../lib/api';
import { elsewhere, publicAddress, signInThere } from '../lib/publicAddress';
import { useServerInfo } from '../lib/queries';
import { queryClient } from '../lib/queryClient';

/** Where to go after signing in: a page of this app, never another site. */
const safeNext = (raw: string | null) => (raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/');

function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-5 py-10">
      <div className="w-full max-w-sm">
        <Wordmark />
        <h1 className="mt-8 font-display text-4xl text-paper">{title}</h1>
        {subtitle && <p className="mt-2 text-[15px] text-muted">{subtitle}</p>}
        <div className="mt-8">{children}</div>
      </div>
    </main>
  );
}

/** What to say when a step fails: the server's words, except after too many tries (a proxy's 429 may say nothing). */
function problem(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) return 'Too many tries. Wait a few minutes and try again.';
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** Runs a step of signing in, keeping what went wrong to show. */
function useStep() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (err) {
      setError(problem(err));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

/**
 * Keeps the account on this device, then carries on: on another origin than the server's public address
 * (PUBLIC_URL), to its sign-in page, username filled in; otherwise `next()`.
 */
async function finish(response: SignInResponse, next: () => void) {
  await signedIn(response);
  const server = await queryClient.ensureQueryData({ queryKey: ['server'], queryFn: api.server });
  const there = elsewhere(server.publicUrl);
  if (there && server.publicUrl) publicAddress.go(signInThere(server.publicUrl, response.account.username));
  else next();
}

/** "This server's address is tracklist.me", on a page served from another origin. */
function PublicAddress({ publicUrl }: { publicUrl: string | undefined }) {
  const there = elsewhere(publicUrl);
  if (!there || !publicUrl) return null;
  return (
    <p className="mt-6 text-[13px] text-muted">
      This server’s address is{' '}
      <a href={publicUrl} className="text-paper-dim underline underline-offset-2 hover:text-paper">
        {there.host}
      </a>
    </p>
  );
}

const Problem = ({ error }: { error: string | null }) => (error ? <InlineError error={error} /> : null);

/** Sign in: or continue as an account already signed in on this device. `?add=1` adds another. */
export function SignInPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const adding = params.has('add');
  const navigate = useNavigate();
  const { data: server } = useServerInfo();
  const stored = useAccounts((s) => s.accounts);
  // Filled in when another address sent us here (see `finish`).
  const [username, setUsername] = useState(params.get('username') ?? '');
  const [password, setPassword] = useState('');
  const { error, busy, run } = useStep();
  const done = () => navigate(next, { replace: true });

  if (server?.setup) {
    return (
      <AuthLayout title="Set up Playarr" subtitle={server.name}>
        <p className="text-[15px] text-paper-dim">
          Nobody has set up this server yet. Choose the owner’s username and password, from your home network, to turn sign-in on.
        </p>
        <Button to="/setup" variant="primary" size="large" className="mt-6 w-full">
          Set up the owner’s account
        </Button>
      </AuthLayout>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await finish(await api.signIn({ username: username.trim(), password, device: deviceName(), platform: 'web' }), done);
    });
  };

  return (
    <AuthLayout title={adding ? 'Add an account' : 'Sign in'} subtitle={server?.name}>
      {!adding && stored.length > 0 && (
        <div className="mb-8 space-y-2">
          {stored.map((a) => (
            <Button
              key={a.accountId}
              size="large"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await switchTo(a.accountId);
                  done();
                })
              }
              className="w-full"
            >
              Continue as {a.name}
            </Button>
          ))}
          <p className="pt-2 text-center text-[13px] text-muted">or sign in to another account</p>
        </div>
      )}
      <form onSubmit={submit} className="space-y-4">
        <TextField label="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
        <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        <Problem error={error} />
        <Button type="submit" variant="primary" size="large" disabled={busy || !username.trim() || !password} className="w-full">
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-[13px] text-muted">
        Got a setup code?{' '}
        <Link to="/redeem" className="text-paper-dim underline underline-offset-2 hover:text-paper">
          Choose your password
        </Link>
      </p>
      <PublicAddress publicUrl={server?.publicUrl} />
    </AuthLayout>
  );
}

/** A new or reset account chooses its password with the code (or link) an admin gave them. */
export function RedeemPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data: server } = useServerInfo();
  const [code, setCode] = useState(params.get('code') ?? '');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const { error, busy, run } = useStep();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (password !== again) throw new Error('The passwords don’t match');
      await finish(await api.redeem({ code: code.trim(), password, device: deviceName(), platform: 'web' }), () => navigate('/', { replace: true }));
    });
  };

  return (
    <AuthLayout title="Choose your password" subtitle={server?.name}>
      <form onSubmit={submit} className="space-y-4">
        <TextField label="Setup code" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoComplete="one-time-code" spellCheck={false} required />
        <TextField label="New password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        <TextField label="Repeat it" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
        <Problem error={error} />
        <Button type="submit" variant="primary" size="large" disabled={busy || !code.trim() || !password} className="w-full">
          Choose password
        </Button>
      </form>
      <p className="mt-6 text-[13px] text-muted">
        At least 8 characters. Already chosen one?{' '}
        <Link to="/sign-in" className="text-paper-dim underline underline-offset-2 hover:text-paper">
          Sign in
        </Link>
      </p>
      <PublicAddress publicUrl={server?.publicUrl} />
    </AuthLayout>
  );
}

/** The owner claims the server: their username and password, from the home network, once. */
export function SetupPage() {
  const navigate = useNavigate();
  const { data: server } = useServerInfo();
  const [name, setName] = useState('');
  // The owner's current username (their profile's) until they type another.
  const [typed, setUsername] = useState<string | null>(null);
  const username = typed ?? server?.ownerUsername ?? '';
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const { error, busy, run } = useStep();

  if (server && !server.setup) {
    return (
      <AuthLayout title="Already set up" subtitle={server.name}>
        <p className="text-[15px] text-paper-dim">This server has an owner. Sign in, or ask an admin for a setup code.</p>
        <Button to="/sign-in" variant="primary" size="large" className="mt-6 w-full">
          Sign in
        </Button>
      </AuthLayout>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (password !== again) throw new Error('The passwords don’t match');
      // Claimed at home (setup works only there); with a public address, everyone signs in there afterwards.
      await finish(await api.setup({ username: username.trim(), name: name.trim(), password, device: deviceName(), platform: 'web' }), () =>
        navigate('/settings/accounts', { replace: true }),
      );
    });
  };

  return (
    <AuthLayout title="Set up Playarr" subtitle={server?.name}>
      <p className="mb-6 text-[15px] text-paper-dim">
        You’re the owner: your listening so far stays yours, and you can add an account for everyone else afterward.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <TextField label="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
        <TextField label="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={32} required />
        <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        <TextField label="Repeat it" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
        <Problem error={error} />
        <Button type="submit" variant="primary" size="large" disabled={busy || !name.trim() || !username.trim() || !password} className="w-full">
          Set up Playarr
        </Button>
      </form>
    </AuthLayout>
  );
}
