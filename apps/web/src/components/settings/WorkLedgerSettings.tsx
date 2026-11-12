import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

function LedgerList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const query = useEnvironmentQuery(
    serverEnvironment.workLedger({
      environmentId,
      input: { limit: 25, ...(cursor === undefined ? {} : { cursor }) },
    }),
  );
  return (
    <SettingsSection
      id="work-ledger"
      title="Work ledger"
      variant="plain"
      headerAction={
        <Button variant="outline" size="sm" onClick={query.refresh} disabled={query.isPending}>
          Refresh
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        Read-only view of shared work and its next action.
      </p>
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      )}
      {query.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading work…
        </p>
      )}
      {query.data && (
        <>
          {query.data.items.length === 0 && (
            <p className="text-sm text-muted-foreground">No work items.</p>
          )}
          <ul className="divide-y divide-border">
            {query.data.items.map((item) => (
              <li key={item.key} className="space-y-2 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{item.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {item.status.replaceAll("_", " ")}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {item.ownerName} · {item.ownerKind}
                  {item.waitReason ? ` · Waiting: ${item.waitReason}` : ""}
                </p>
                <p className="whitespace-pre-wrap break-words text-sm">
                  {item.nextAction || "No next action recorded."}
                </p>
                {item.ownerThreadId && (
                  <Link
                    to="/$environmentId/$threadId"
                    params={buildThreadRouteParams(
                      scopeThreadRef(environmentId, item.ownerThreadId),
                    )}
                    className="text-sm underline underline-offset-2"
                  >
                    Open owner thread
                  </Link>
                )}
              </li>
            ))}
          </ul>
          <div className="flex justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={cursors.length === 0}
              onClick={() => setCursors(cursors.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={query.data.nextCursor === null}
              onClick={() => {
                if (query.data?.nextCursor) setCursors([...cursors, query.data.nextCursor]);
              }}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </SettingsSection>
  );
}

export function WorkLedgerSettings() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const selected = environment ?? connectedEnvironments[0];
  return (
    <SettingsPageContainer>
      {selected ? (
        <LedgerList key={selected.environmentId} environmentId={selected.environmentId} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Connect to an environment to read its work ledger.
        </p>
      )}
    </SettingsPageContainer>
  );
}
