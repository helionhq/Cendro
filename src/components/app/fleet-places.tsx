"use client";

import { useMutation, useQuery_experimental } from "convex/react";
import { Archive, MapPin, Plus } from "lucide-react";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMinuteNow } from "@/lib/use-minute-now";
import { useCompany } from "./company-context";
import {
  ConfirmDialog,
  PlaceDialog,
  RecordMenu,
  errorMessage,
} from "./fleet-dialogs";
import {
  googleMapsUrl,
  relativeTime,
  type FleetPlace,
  type FleetPlaceSuggestion,
} from "./fleet-format";
import { FleetPage, useFleetAccess } from "./fleet-shell";
import {
  DashedPanel,
  EmptyPanel,
  FleetNotice,
  QueryError,
  SectionHeading,
  SkeletonBlock,
} from "./fleet-ui";

type PlaceDialogState =
  | { mode: "add"; kind: "base" | "destination" }
  | { mode: "edit"; place: FleetPlace }
  | { mode: "suggestion"; suggestion: FleetPlaceSuggestion };

export function PlacesPage() {
  const { activeCompanyId } = useCompany();
  const { canManage, canView } = useFleetAccess();
  const now = useMinuteNow();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showAllSuggestions, setShowAllSuggestions] = useState(false);
  const [dialog, setDialog] = useState<PlaceDialogState | null>(null);
  const [archiving, setArchiving] = useState<FleetPlace | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const setPlaceArchived = useMutation(api.fleetPlaces.setPlaceArchived);

  const placesResult = useQuery_experimental({
    query: api.fleetPlaces.listPlaces,
    args: activeCompanyId && canView ? { companyId: activeCompanyId, includeArchived: true } : "skip",
  });
  const suggestionsResult = useQuery_experimental({
    query: api.fleetPlaces.suggestPlaces,
    args: activeCompanyId && canView ? { companyId: activeCompanyId, now } : "skip",
  });

  const places = (placesResult.status === "success" ? placesResult.data.places : []) as FleetPlace[];
  const suggestions = (suggestionsResult.status === "success"
    ? suggestionsResult.data.suggestions
    : []) as FleetPlaceSuggestion[];
  const loading = placesResult.status === "pending" || suggestionsResult.status === "pending";
  const queryError = placesResult.status === "error" || suggestionsResult.status === "error";

  const active = places.filter((place) => !place.archived);
  const warehouses = active.filter((place) => place.kind === "base");
  const searchTerm = search.trim().toLowerCase();
  const destinations = active
    .filter((place) => place.kind === "destination")
    .filter(
      (place) =>
        !searchTerm ||
        place.name.toLowerCase().includes(searchTerm) ||
        (place.address ?? "").toLowerCase().includes(searchTerm),
    );
  const archived = places.filter((place) => place.archived);
  const visibleSuggestions = showAllSuggestions ? suggestions : suggestions.slice(0, 3);

  async function archivePlace(place: FleetPlace) {
    if (!activeCompanyId) return;
    await setPlaceArchived({ companyId: activeCompanyId, placeId: place._id, archived: true });
    setNotice("Place archived.");
  }

  async function restorePlace(place: FleetPlace) {
    if (!activeCompanyId || restoringId) return;
    setRestoringId(place._id);
    setError(null);
    try {
      await setPlaceArchived({ companyId: activeCompanyId, placeId: place._id, archived: false });
      setNotice("Place restored.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <FleetPage
      title="Places"
      description="Warehouses and regular destinations. The tracker uses them to know when a trip arrives."
      activeTab="places"
      actions={
        canManage ? (
          <Button
            type="button"
            variant="primary"
            className="h-11 w-full sm:h-10 sm:w-auto"
            onClick={() => setDialog({ mode: "add", kind: "destination" })}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add place
          </Button>
        ) : undefined
      }
    >
      {notice && <FleetNotice message={notice} onDismiss={() => setNotice(null)} />}
      {error && <FleetNotice tone="error" message={error} onDismiss={() => setError(null)} />}
      {queryError && (
        <QueryError
          message="Could not load places. Check your connection and try again."
          onRetry={() => window.location.reload()}
        />
      )}

      {queryError ? null : loading ? (
        <PlacesSkeleton />
      ) : active.length === 0 && archived.length === 0 ? (
        <EmptyPanel
          icon={MapPin}
          title="No places yet"
          body="Add your warehouse first, then the places your vehicles visit often."
          action={
            canManage ? (
              <Button
                type="button"
                variant="primary"
                className="h-10"
                onClick={() => setDialog({ mode: "add", kind: "base" })}
              >
                Add warehouse
              </Button>
            ) : (
              <span className="text-[13px] text-[var(--ink-muted)]">Ask an admin to add places.</span>
            )
          }
        />
      ) : (
        <>
          <section aria-labelledby="fleet-warehouses">
            <SectionHeading
              id="fleet-warehouses"
              title={`Warehouses${warehouses.length > 0 ? ` ${warehouses.length}` : ""}`}
              description="Where trips start and end."
              action={
                canManage && warehouses.length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-9"
                    onClick={() => setDialog({ mode: "add", kind: "base" })}
                  >
                    Add warehouse
                  </Button>
                ) : undefined
              }
            />
            {warehouses.length === 0 ? (
              <DashedPanel>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>No warehouse saved yet. Trips start and end at a warehouse.</span>
                  {canManage && (
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-10"
                      onClick={() => setDialog({ mode: "add", kind: "base" })}
                    >
                      Add warehouse
                    </Button>
                  )}
                </div>
              </DashedPanel>
            ) : (
              <div className="divide-y divide-[var(--hairline)] rounded-xl border border-[var(--hairline)] bg-[var(--surface)]">
                {warehouses.map((place) => (
                  <PlaceRow
                    key={place._id}
                    place={place}
                    canManage={canManage}
                    onEdit={() => setDialog({ mode: "edit", place })}
                    onArchive={() => setArchiving(place)}
                  />
                ))}
              </div>
            )}
          </section>

          {suggestions.length > 0 && (
            <section aria-labelledby="fleet-suggested-places">
              <SectionHeading
                id="fleet-suggested-places"
                title="Suggested places"
                description="Stops your vehicles made in the last 30 days."
              />
              <div className="divide-y divide-[var(--hairline)] rounded-xl border border-[var(--hairline)] bg-[var(--surface)]">
                {visibleSuggestions.map((suggestion, index) => (
                  <div
                    key={`${suggestion.lat}-${suggestion.lng}-${index}`}
                    className="flex flex-wrap items-center gap-3 px-3.5 py-3 sm:px-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-[var(--ink)]">
                        {suggestion.address || "Suggested place"}
                      </div>
                      <div className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                        Visited {suggestion.visitCount} {suggestion.visitCount === 1 ? "time" : "times"} ·
                        {" "}last {relativeTime(suggestion.lastVisitAt, now)}
                      </div>
                    </div>
                    {canManage && (
                      <Button
                        type="button"
                        variant="primary"
                        className="h-10 w-full shrink-0 sm:w-auto"
                        onClick={() => setDialog({ mode: "suggestion", suggestion })}
                      >
                        Add place
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              {suggestions.length > 3 && (
                <button
                  type="button"
                  className="mt-2 text-[12px] font-medium text-[var(--ink-secondary)] hover:text-[var(--ink)]"
                  onClick={() => setShowAllSuggestions((value) => !value)}
                >
                  {showAllSuggestions
                    ? "Show fewer suggestions"
                    : `Show ${suggestions.length - 3} more suggestions`}
                </button>
              )}
            </section>
          )}

          <section aria-labelledby="fleet-destinations">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <SectionHeading
                id="fleet-destinations"
                title={`Destinations${active.filter((place) => place.kind === "destination").length > 0 ? ` ${active.filter((place) => place.kind === "destination").length}` : ""}`}
              />
              {(active.filter((place) => place.kind === "destination").length > 8 ||
                search.trim() !== "") && (
                <label className="flex items-center gap-2 text-[12px] text-[var(--ink-muted)]">
                  <span className="sr-only">Search places</span>
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search places…"
                    className="h-10 w-[190px] text-[13px]"
                  />
                </label>
              )}
            </div>
            {destinations.length === 0 ? (
              <DashedPanel>
                {search.trim()
                  ? "No destinations match that search."
                  : "No destinations saved yet. Add the places your vehicles visit often."}
              </DashedPanel>
            ) : (
              <div className="divide-y divide-[var(--hairline)] rounded-xl border border-[var(--hairline)] bg-[var(--surface)]">
                {destinations.map((place) => (
                  <PlaceRow
                    key={place._id}
                    place={place}
                    canManage={canManage}
                    onEdit={() => setDialog({ mode: "edit", place })}
                    onArchive={() => setArchiving(place)}
                  />
                ))}
              </div>
            )}
          </section>

          {archived.length > 0 && (
            <section aria-labelledby="fleet-archived-places">
              <button
                type="button"
                className="text-[12px] font-medium text-[var(--ink-secondary)] hover:text-[var(--ink)]"
                onClick={() => setShowArchived((value) => !value)}
                aria-expanded={showArchived}
              >
                {showArchived ? "Hide archived places" : `Show archived (${archived.length})`}
              </button>
              {showArchived && (
                <div className="mt-2 divide-y divide-[var(--hairline)] rounded-xl border border-[var(--hairline)] bg-[var(--surface)]">
                  {archived.map((place) => (
                    <div key={place._id} className="flex flex-wrap items-center gap-3 px-3.5 py-3 sm:px-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-[var(--ink)]">{place.name}</span>
                          <Badge tone="neutral">Archived</Badge>
                        </div>
                        <div className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                          {place.address || `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`}
                        </div>
                      </div>
                      {canManage && (
                        <Button
                          type="button"
                          variant="secondary"
                          className="h-10 shrink-0"
                          disabled={restoringId === place._id}
                          onClick={() => void restorePlace(place)}
                        >
                          {restoringId === place._id ? "Restoring…" : "Restore"}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {placesResult.status === "success" && placesResult.data.isTruncated && (
            <p className="text-[12px] text-[var(--ink-faint)]">Showing the first 200 places.</p>
          )}
        </>
      )}

      {activeCompanyId && dialog && (
        <PlaceDialog
          companyId={activeCompanyId}
          now={now}
          place={dialog.mode === "edit" ? dialog.place : undefined}
          suggestion={dialog.mode === "suggestion" ? dialog.suggestion : undefined}
          defaultKind={dialog.mode === "add" ? dialog.kind : "destination"}
          onClose={() => setDialog(null)}
          onSaved={(message) => { setNotice(message); setDialog(null); }}
        />
      )}
      {activeCompanyId && archiving && (
        <ConfirmDialog
          open
          title="Archive place?"
          description={`Past trips keep the name “${archiving.name}”. It will no longer appear in the trip list or start/end detection.`}
          confirmLabel="Archive"
          onConfirm={() => archivePlace(archiving)}
          onClose={() => setArchiving(null)}
        />
      )}
    </FleetPage>
  );
}

function PlaceRow({
  place,
  canManage,
  onEdit,
  onArchive,
}: {
  place: FleetPlace;
  canManage: boolean;
  onEdit: () => void;
  onArchive: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-3.5 py-3 sm:px-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-[var(--ink)]">{place.name}</span>
          <Badge tone={place.kind === "base" ? "blue" : "neutral"}>
            {place.kind === "base" ? "Warehouse" : "Destination"}
          </Badge>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--ink-muted)]">
          <span>{place.address || `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`}</span>
          <span className="text-[var(--ink-faint)]">·</span>
          <span>{place.radiusMeters} m</span>
          <span className="text-[var(--ink-faint)]">·</span>
          <a
            href={googleMapsUrl(place.lat, place.lng)}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-[var(--ink-secondary)] underline-offset-2 hover:text-[var(--ink)] hover:underline"
          >
            Open in Google Maps
          </a>
        </div>
      </div>
      {canManage && (
        <RecordMenu
          label={place.name}
          onEdit={onEdit}
          onDelete={onArchive}
          editLabel="Edit place"
          deleteLabel="Archive place"
          deleteIcon={Archive}
        />
      )}
    </div>
  );
}

function PlacesSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading places">
      <SkeletonBlock className="h-5 w-32" />
      <SkeletonBlock className="h-16" />
      <SkeletonBlock className="h-16" />
      <SkeletonBlock className="h-5 w-40" />
      <SkeletonBlock className="h-16" />
      <SkeletonBlock className="h-16" />
      <SkeletonBlock className="h-16" />
    </div>
  );
}
