import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="mx-auto mt-32 max-w-md px-5 text-center">
      <div className="font-mono text-[11px] tracking-[0.25em] text-muted uppercase">Side C</div>
      <h1 className="mt-3 font-display text-5xl text-paper">This groove is empty.</h1>
      <Link to="/" className="mt-8 inline-block font-mono text-[12px] tracking-[0.15em] text-accent uppercase hover:underline">
        Back home
      </Link>
    </div>
  );
}
