import { HelpTabs } from "./tabs";

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-8">
      <HelpTabs />
      {children}
    </div>
  );
}
