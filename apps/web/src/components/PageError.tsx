import { RotateCw } from 'lucide-react';
import { useEffect } from 'react';
import { useLocation, useNavigate, useRouteError } from 'react-router';
import { isStaleBuild, reloadIntoNewBuild } from '../lib/staleBuild';
import { Button } from './Button';
import { ErrorState } from './States';

/**
 * A page that failed, in place of the page: the shell, the player bar and the music carry on. A page whose file
 * belongs to a build that's been replaced reloads into the new one when nothing's playing, else asks.
 */
export function PageError() {
  const error = useRouteError();
  const navigate = useNavigate();
  const location = useLocation();
  const stale = isStaleBuild(error);
  useEffect(() => {
    if (stale) reloadIntoNewBuild();
  }, [stale]);
  if (stale) return <Updated />;
  // Opening the page again clears the error.
  return <ErrorState error={error} onRetry={() => navigate(location, { replace: true })} />;
}

/** The whole app failed (the shell itself, or a sign-in page): there's no player bar left to keep. */
export function AppError() {
  const error = useRouteError();
  const stale = isStaleBuild(error);
  useEffect(() => {
    if (stale) reloadIntoNewBuild();
  }, [stale]);
  return stale ? <Updated /> : <ErrorState error={error} onRetry={() => window.location.reload()} />;
}

function Updated() {
  return (
    <div className="mx-auto mt-24 max-w-md px-5 text-center" role="alert">
      <div className="font-display text-3xl text-paper">Playarr was updated.</div>
      <p className="mt-3 text-sm text-muted">Reload to open this page in the new version.</p>
      <Button variant="primary" icon={<RotateCw />} onClick={() => window.location.reload()} className="mt-6">
        Reload
      </Button>
    </div>
  );
}
