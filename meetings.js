import { createHash } from "node:crypto";
import { buildTranscript, orderSegments, toText } from "./transcripts.js";
import { normaliseThreadIdentity } from "./communicationModel.js";
import { resolveCalendarEvent } from "./calendar.js";

export class MeetingError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
const text = (value, max = 4000) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const required = (value, name, max = 200) => {
  if (typeof value === "string" && value.trim().length > max)
    throw new MeetingError(400, `${name} exceeds ${max} characters`);
  const result = text(value, max);
  if (!result) throw new MeetingError(400, `${name} is required`);
  return result;
};
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");

export function normalizeMeeting(raw = {}) {
  if (Buffer.byteLength(JSON.stringify(raw)) > 1_000_000)
    throw new MeetingError(413, "Meeting upload exceeds 1 MB");
  const source = required(raw.source, "Source", 80);
  const externalId = required(raw.externalId, "Provider meeting ID");
  const sourceVersion = required(raw.sourceVersion, "Provider version");
  const title = required(raw.title, "Meeting title", 500);
  const occurredAt = required(raw.occurredAt, "Meeting time");
  if (
    !/(Z|[+-]\d\d:\d\d)$/.test(occurredAt) ||
    !Number.isFinite(Date.parse(occurredAt))
  )
    throw new MeetingError(
      400,
      "Meeting time needs an explicit timezone offset",
    );
  const date = occurredAt.slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}T/.test(occurredAt) ||
    new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date
  )
    throw new MeetingError(400, "Meeting date is invalid");
  if (
    raw.expectedVersion !== undefined &&
    (!Number.isSafeInteger(raw.expectedVersion) || raw.expectedVersion < 0)
  )
    throw new MeetingError(
      400,
      "expectedVersion must be a non-negative integer",
    );
  const visibility = raw.visibility === "private" ? "private" : "project";
  if (Array.isArray(raw.attendees) && raw.attendees.length > 100)
    throw new MeetingError(400, "Supply at most 100 attendees");
  const attendees = (Array.isArray(raw.attendees) ? raw.attendees : []).map(
    (person) => ({
      id: required(person.id, "Attendee reference", 100),
      name: required(person.name, "Attendee name", 200),
      email: text(person.email, 320).toLowerCase(),
      phone: text(person.phone, 40),
    }),
  );
  if (new Set(attendees.map((p) => p.id)).size !== attendees.length)
    throw new MeetingError(400, "Attendee references must be unique");
  if (
    !Array.isArray(raw.topics) ||
    !raw.topics.length ||
    raw.topics.length > 20
  )
    throw new MeetingError(
      400,
      "Supply 1–20 separately identified meeting topics",
    );
  let count = 0;
  const topics = raw.topics.map((topic) => {
    const id = required(topic.id, "Topic reference", 100);
    const projectId = required(topic.projectId, "Topic project", 300);
    if (!Array.isArray(topic.segments) || !topic.segments.length)
      throw new MeetingError(400, "Each topic needs transcript segments");
    const segments = topic.segments.map((segment) => {
      if (++count > 1000)
        throw new MeetingError(400, "Supply at most 1000 transcript segments");
      const speakerId = text(segment.speakerId, 100);
      const person = attendees.find((p) => p.id === speakerId);
      if (speakerId && !person)
        throw new MeetingError(
          400,
          "Speaker reference must identify a supplied attendee or be blank",
        );
      for (const key of ["startMs", "endMs"])
        if (
          segment[key] != null &&
          (!Number.isFinite(segment[key]) || segment[key] < 0)
        )
          throw new MeetingError(
            400,
            "Segment times must be non-negative numbers",
          );
      if (
        segment.startMs != null &&
        segment.endMs != null &&
        segment.endMs < segment.startMs
      )
        throw new MeetingError(400, "Segment end precedes its start");
      return {
        id: required(segment.id, "Segment reference", 100),
        speakerId: speakerId || null,
        speaker:
          text(segment.speaker, 200) || person?.name || "Unknown speaker",
        text: required(segment.text, "Segment text", 20000),
        startMs: Number.isFinite(segment.startMs)
          ? Math.max(0, segment.startMs)
          : null,
        endMs: Number.isFinite(segment.endMs)
          ? Math.max(0, segment.endMs)
          : null,
      };
    });
    if (new Set(segments.map((s) => s.id)).size !== segments.length)
      throw new MeetingError(
        400,
        "Segment references must be unique within each topic",
      );
    return {
      id,
      title: required(topic.title, "Topic title", 500),
      projectId,
      threadId: text(topic.threadId, 160) || null,
      segments,
    };
  });
  if (new Set(topics.map((t) => t.id)).size !== topics.length)
    throw new MeetingError(400, "Topic references must be unique");
  const references = {
    calendarEventId: text(raw.references?.calendarEventId, 160) || null,
    recordingUrl: text(raw.references?.recordingUrl, 2000) || null,
    sourceUrl: text(raw.references?.sourceUrl, 2000) || null,
  };
  const content = {
    title,
    occurredAt,
    visibility,
    attendees,
    topics,
    references,
  };
  return {
    ...content,
    source,
    externalId,
    sourceVersion,
    key: hash([source, externalId]),
    fingerprint: hash(content),
    expectedVersion: raw.expectedVersion ?? 0,
    allowedProjectIds: Array.isArray(raw.allowedProjectIds)
      ? raw.allowedProjectIds
          .filter((v) => typeof v === "string")
          .slice(0, 1000)
      : null,
    duplicateDecision: raw.duplicateDecision === "separate" ? "separate" : null,
    duplicateReason: text(raw.duplicateReason),
    actor: null,
  };
}

export async function prepareMeeting(db, raw, actor) {
  const meeting = normalizeMeeting(raw);
  meeting.actor = actor;
  if (meeting.references.calendarEventId) {
    const event = await resolveCalendarEvent(
      db,
      meeting.references.calendarEventId,
    );
    if (!event)
      throw new MeetingError(
        400,
        "Calendar reference did not resolve to one accessible event",
      );
    meeting.calendarEventId = event.id;
  }
  const identityRows = (
    await Promise.all(
      ["email", "phone"].map(async (type) => {
        const values = [
          ...new Set(
            meeting.attendees
              .map((p) => normaliseThreadIdentity(p[type]))
              .filter(Boolean),
          ),
        ];
        if (!values.length) return [];
        const result = await db
          .from("communication_identities")
          .select("type,normalized_value,person_id")
          .eq("type", type)
          .in("normalized_value", values)
          .limit(201);
        if (result.error)
          throw new MeetingError(503, "Contact identity lookup unavailable");
        return result.data || [];
      }),
    )
  ).flat();
  for (const attendee of meeting.attendees) {
    const matches = new Set();
    let supplied = 0;
    let ambiguous = false;
    for (const [type, value] of [
      ["email", attendee.email],
      ["phone", attendee.phone],
    ]) {
      if (!value) continue;
      supplied++;
      const ids = [
        ...new Set(
          identityRows
            .filter(
              (r) =>
                r.type === type &&
                r.normalized_value === normaliseThreadIdentity(value),
            )
            .map((r) => r.person_id),
        ),
      ];
      if (ids.length !== 1) ambiguous = true;
      ids.forEach((id) => matches.add(id));
    }
    attendee.personId =
      supplied && !ambiguous && matches.size === 1 ? [...matches][0] : null;
    attendee.identityStatus = attendee.personId
      ? "matched_exact"
      : "unresolved";
    attendee.contact_id = attendee.personId;
    attendee.identity_type = attendee.email
      ? "email"
      : attendee.phone
        ? "phone"
        : null;
    attendee.identity_value = attendee.email || attendee.phone || null;
    attendee.identityEvidence = {
      method: "existing_canonical_identity",
      email: attendee.email || null,
      phone: attendee.phone || null,
    };
  }
  const matched = [
    ...new Set(meeting.attendees.map((p) => p.personId).filter(Boolean)),
  ];
  if (matched.length) {
    const contacts = await db
      .from("contacts")
      .select("id,name,email,phone_number")
      .in("id", matched);
    if (contacts.error)
      throw new MeetingError(503, "Contact enrichment unavailable");
    for (const attendee of meeting.attendees)
      attendee.contact =
        (contacts.data || []).find((p) => p.id === attendee.personId) || null;
  }
  for (const topic of meeting.topics) {
    const ordered = orderSegments(topic.segments);
    const transcript = buildTranscript({
      channel: "recording",
      provider: meeting.source,
      segments: ordered.map((s) => ({ ...s, role: "unknown" })),
    });
    // An exact attendee match is not proof of who spoke. Retain producer attribution separately.
    transcript.segments = transcript.segments.map((segment, index) => ({
      ...segment,
      sourceSegmentId: ordered[index].id,
      speakerId: ordered[index].speakerId,
      attributedPersonId:
        meeting.attendees.find((p) => p.id === ordered[index].speakerId)
          ?.personId || null,
      attribution: "source_claim",
    }));
    topic.transcript = transcript;
    topic.transcriptText = toText(transcript);
  }
  return meeting;
}

export async function ingestMeeting(db, raw, actor) {
  const meeting = await prepareMeeting(db, raw, actor);
  const result = await db.rpc("ingest_transcribed_meeting", {
    p_meeting: meeting,
  });
  if (result.error)
    throw new MeetingError(
      /version|changed|thread|project/i.test(result.error.message) ? 409 : 503,
      result.error.message,
    );
  if (result.data?.status === "needs_duplicate_review")
    throw new MeetingError(
      409,
      "Similar meeting content already exists. Review before importing a separate meeting.",
      result.data,
    );
  return result.data;
}

export async function getMeeting(db, id) {
  const result = await db
    .from("recordings")
    .select("id,title,recorded_at,metadata,updated_at")
    .eq("id", id)
    .eq("metadata->>kind", "meeting_manifest")
    .maybeSingle();
  if (result.error) throw new MeetingError(503, "Meeting is unavailable");
  if (!result.data) throw new MeetingError(404, "Meeting not found");
  const history = await db
    .from("recording_revisions")
    .select("version,source_version,fingerprint,created_at,actor")
    .eq("recording_id", id)
    .order("version");
  if (history.error) throw new MeetingError(503, "Meeting history unavailable");
  return { ...result.data, history: history.data || [] };
}

export async function findMeetingBySource(db, source, externalId) {
  const result = await db
    .from("recordings")
    .select("id")
    .eq("source", "meeting_transcript")
    .eq("external_id", "meeting:" + hash([source, externalId]))
    .maybeSingle();
  if (result.error) throw new MeetingError(503, "Meeting lookup unavailable");
  return result.data ? getMeeting(db, result.data.id) : null;
}

export async function listMeetings(db, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
    throw new MeetingError(400, "Invalid meeting cursor");
  const result = await db
    .from("recordings")
    .select("id,title,recorded_at,metadata,updated_at")
    .eq("metadata->>kind", "meeting_manifest")
    .neq("metadata->>visibility", "private")
    .order("created_at", { ascending: false })
    .range(offset, offset + 50);
  if (result.error) throw new MeetingError(503, "Meetings are unavailable");
  return {
    data: (result.data || []).slice(0, 50),
    next: result.data?.length > 50 ? offset + 50 : null,
  };
}
