// 이 프로그램의 원래 목적("편집점" 찾기)에 가장 직접적으로 맞닿아 있는 모듈.
// timeline.ts가 계산한 활동 구간/하이라이트에서 "영상 편집할 때 참고할 만한 시점"만 뽑아,
// 실제 다시보기(VOD) 영상을 스크러빙하면서 바로 대조해볼 수 있는 형태로 정리한다.
//
// 시각은 전부 "방송 시작을 00:00:00으로 둔 경과 시간(VOD 타임코드)"으로 표시한다. 방송 시작
// 시각(epoch ms) 기준이 아니라 이 상대 시간을 써야, 편집자가 다운로드한 VOD 파일의 재생
// 위치와 그대로 맞아떨어지기 때문이다.
import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import type { BroadcastSession, TimelineData } from "./types";
import { sanitizeFilenamePart } from "./report";

export interface EditPoint {
  type: "rest" | "burst" | "donation" | "quiet";
  label: string;
  detail: string;
  startMs: number; // 방송 시작 기준 경과 시간(ms)
  endMs?: number; // 구간이 있는 경우만(현재는 휴식중만 구간을 가짐)
}

function elapsed(atMs: number, sessionStart: number): number {
  return Math.max(0, atMs - sessionStart);
}

const HIGHLIGHT_LABELS: Record<EditPoint["type"], string> = {
  rest: "휴식(자리비움)",
  burst: "채팅 폭발",
  donation: "후원 몰림",
  quiet: "채팅 잠잠",
};

/**
 * 편집점 후보 목록을 만든다: 휴식중(자리비움) 구간 전부 + 하이라이트(채팅 폭발/후원 몰림/
 * 채팅 잠잠) 전부를 시간순으로 합친다. 방송 도중(세션이 아직 안 끝난 상태)에 호출해도
 * 그 시점까지 확정된 구간/하이라이트만으로 동작한다.
 */
export function buildEditPoints(timeline: TimelineData): EditPoint[] {
  const points: EditPoint[] = [];

  timeline.segments
    .filter((s) => s.type === "휴식중")
    .forEach((s) => {
      // 먹방(영상 분석으로 판단한 EATING) 구간은 자리비움과 헷갈리지 않도록 라벨/설명을
      // 따로 구분한다 — timeline.ts가 이 라벨을 "먹방"으로 붙여준다.
      const isEating = s.label === "먹방";
      points.push({
        type: "rest",
        label: isEating ? "휴식(먹방)" : HIGHLIGHT_LABELS.rest,
        detail: isEating
          ? "영상 분석으로 감지된 먹방(식사) 구간"
          : timeline.restSource === "motion"
          ? "화면 변화 감지로 확정된 자리비움 구간"
          : timeline.restSource === "vision"
          ? "영상 분석으로 감지된 휴식 구간"
          : "채팅량이 잠잠해져 자리비움으로 추정된 구간",
        startMs: elapsed(s.start, timeline.sessionStart),
        endMs: elapsed(s.end, timeline.sessionStart),
      });
    });

  timeline.highlights.forEach((h) => {
    points.push({
      type: h.type,
      label: HIGHLIGHT_LABELS[h.type],
      detail: h.detail,
      startMs: elapsed(h.time, timeline.sessionStart),
    });
  });

  return points.sort((a, b) => a.startMs - b.startMs);
}

function fmtTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * 편집점 목록을 CSV로 만든다. 엑셀에서 한글이 안 깨지도록 UTF-8 BOM을 앞에 붙인다.
 * 컬럼: 구분(휴식/채팅 폭발/후원 몰림/채팅 잠잠), 시작(방송 경과 HH:MM:SS), 종료(구간이
 * 있는 경우만), 길이(초), 설명.
 */
export const CSV_BOM = "﻿";

export function buildEditPointsCsv(timeline: TimelineData): string {
  const points = buildEditPoints(timeline);
  const header = "구분,시작,종료,길이(초),설명";
  const rows = points.map((p) => {
    const start = fmtTimecode(p.startMs);
    const end = p.endMs !== undefined ? fmtTimecode(p.endMs) : "";
    const durationSec = p.endMs !== undefined ? Math.round((p.endMs - p.startMs) / 1000) : "";
    return [csvEscape(p.label), start, end, String(durationSec), csvEscape(p.detail)].join(",");
  });
  return CSV_BOM + [header, ...rows].join("\r\n") + "\r\n";
}

/** 사람이 눈으로 훑어보기 좋은 순수 텍스트 버전 (메모장/카톡 등에 바로 붙여넣기용). */
export function buildEditPointsText(timeline: TimelineData, channelName: string): string {
  const points = buildEditPoints(timeline);
  const lines = [`${channelName} 방송 편집점 목록 (방송 시작 기준 경과 시간)`, ""];
  if (points.length === 0) {
    lines.push("(편집점으로 잡힌 구간이 없습니다)");
  } else {
    points.forEach((p) => {
      const range = p.endMs !== undefined ? `${fmtTimecode(p.startMs)} ~ ${fmtTimecode(p.endMs)}` : fmtTimecode(p.startMs);
      lines.push(`[${p.label}] ${range} - ${p.detail}`);
    });
  }
  return lines.join("\n") + "\n";
}

/**
 * 방송이 끝날 때마다 리포트(.md)와 나란히 편집점 CSV도 자동으로 저장한다 (CLI/GUI 공통,
 * 버튼을 따로 안 눌러도 항상 남는다 — report.ts의 saveReport()와 같은 네이밍 규칙을 쓴다).
 * 편집점이 하나도 없으면(휴식/하이라이트가 전혀 안 잡힌 방송) 빈 파일을 만들 필요가 없으니
 * 저장을 건너뛰고 null을 돌려준다.
 */
export function saveEditPointsCsv(
  session: BroadcastSession,
  timeline: TimelineData,
  outDir: string
): string | null {
  const points = buildEditPoints(timeline);
  if (points.length === 0) return null;

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const filename = `${sanitizeFilenamePart(session.channelName)}_${dayjs(session.startedAt).format(
    "YYYYMMDD_HHmm"
  )}_editpoints.csv`;
  const filePath = path.join(outDir, filename);
  fs.writeFileSync(filePath, buildEditPointsCsv(timeline), "utf-8");
  return filePath;
}
