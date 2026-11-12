import { createFileRoute } from "@tanstack/react-router";
import { WorkLedgerSettings } from "../components/settings/WorkLedgerSettings";

export const Route = createFileRoute("/_chat/settings/work-ledger")({
  component: WorkLedgerSettings,
});
