import { ListPlus } from 'lucide-react';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { QueueView, useSaveQueue } from '../components/QueueView';

/**
 * The Queue page: the Queue tab on a phone, and the sidebar's Queue. At desktop widths the player bar's Queue opens
 * the same queue in the column beside the page instead (components/SideColumn.tsx).
 */
export function QueuePage() {
  const save = useSaveQueue();
  return (
    <div className="max-w-4xl px-5 pt-8 md:px-10 md:pt-14">
      <PageHeader
        title="Queue"
        actions={
          save && (
            <Button icon={<ListPlus />} onClick={save}>
              Save as playlist
            </Button>
          )
        }
      />
      <QueueView />
    </div>
  );
}
