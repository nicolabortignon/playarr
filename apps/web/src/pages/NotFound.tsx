import { Button } from '../components/Button';

export function NotFoundPage() {
  return (
    <div className="mx-auto mt-32 max-w-md px-5 text-center">
      <div className="type-kicker text-muted">Side C</div>
      <h1 className="mt-3 font-display text-5xl text-paper">This groove is empty.</h1>
      <Button to="/" className="mt-8">
        Back home
      </Button>
    </div>
  );
}
