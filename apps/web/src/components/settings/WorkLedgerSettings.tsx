import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { T, Var, useGT } from "gt-react";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

function LedgerList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
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
      title={gt("Work ledger")}
      variant="plain"
      headerAction={
        <Button variant="outline" size="sm" onClick={query.refresh} disabled={query.isPending}>
          <T>Refresh</T>
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        <T>Read-only view of shared work and its next action.</T>
      </p>
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      )}
      {query.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          <T>Loading work…</T>
        </p>
      )}
      {query.data && (
        <>
          {query.data.items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              <T>No work items.</T>
            </p>
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
                  {item.waitReason ? (
                    <>
                      {" · "}
                      <T>
                        Waiting: <Var>{item.waitReason}</Var>
                      </T>
                    </>
                  ) : null}
                </p>
                <p className="whitespace-pre-wrap break-words text-sm">
                  {item.nextAction || <T>No next action recorded.</T>}
                </p>
                {item.approval && (
                  <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    <T>
                      Your approval: “<Var>{item.approval.quotedAnswer}</Var>”
                    </T>
                  </p>
                )}
                {item.ownerThreadId && (
                  <Link
                    to="/$environmentId/$threadId"
                    params={buildThreadRouteParams(
                      scopeThreadRef(environmentId, item.ownerThreadId),
                    )}
                    className="text-sm underline underline-offset-2"
                  >
                    <T>Open owner thread</T>
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
              <T>Previous</T>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={query.data.nextCursor === null}
              onClick={() => {
                if (query.data?.nextCursor) setCursors([...cursors, query.data.nextCursor]);
              }}
            >
              <T>Next</T>
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
          <T>Connect to an environment to read its work ledger.</T>
        </p>
      )}
    </SettingsPageContainer>
  );
}
