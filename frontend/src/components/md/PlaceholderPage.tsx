// A page that is not built yet: its header, and an honest "coming" block. Each MD page replaces this with its content.
import { Hammer } from "lucide-react";
import MdLayout from "./MdLayout";
import { MD_NAV_BY_ID } from "./md-nav";
import MdPageHeader from "./kit/MdPageHeader";
import { EmptyBlock } from "./kit/states";

export default function PlaceholderPage({ id }: { id: string }) {
  const page = MD_NAV_BY_ID[id];
  return (
    <MdLayout>
      <div className="mx-auto max-w-[1500px] space-y-5">
        <MdPageHeader icon={page.icon} title={page.title} subtitle="This page is being built." />
        <div className="md-card">
          <EmptyBlock icon={Hammer} title="Coming together" className="py-14">
            {page.title} is not ready yet.
          </EmptyBlock>
        </div>
      </div>
    </MdLayout>
  );
}
