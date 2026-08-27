import type { LucideIcon } from 'lucide-react';
import { Construction } from 'lucide-react';
import AppShell from '@/components/AppShell';

interface StubPageProps {
  variant: 'agent' | 'admin';
  title: string;
  description: string;
  icon?: LucideIcon;
}

/** Placeholder sub-page: AppShell + title card. Page agents replace these. */
export function StubPage({ variant, title, description, icon: Icon = Construction }: StubPageProps) {
  return (
    <AppShell variant={variant} title={title}>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="instrument-panel flex max-w-md flex-col items-center gap-3 p-10 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-[14px] border border-line bg-ink-800">
            <Icon className="h-5 w-5 text-signal" />
          </span>
          <h2 className="font-display text-[28px] font-semibold leading-[34px] tracking-tight text-text-hi">
            {title}
          </h2>
          <p className="text-sm text-text-mid">{description}</p>
        </div>
      </div>
    </AppShell>
  );
}
