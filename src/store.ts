// 세션/채팅 데이터를 저장하는 모듈. 여기까지 오는 데 시행착오가 좀 있었다:
//   1차: better-sqlite3 -> 네이티브 모듈이라 설치 시 컴파일이 필요했고, 샌드박스에서도
//        빌드가 실패했다. 배포용 앱에서 재컴파일 문제가 생길 걸 감안해서 뺐다.
//   2차: node:sqlite(Node 22.5+ 내장) -> 네이티브 컴파일은 피했지만, Electron이 자체
//        번들하는 Node 버전이 22.5 미만이면(예: Electron 32는 Node 20) 이 모듈 자체가
//        없어서 GUI가 아예 안 켜지는 문제가 실제로 발생했다.
//   3차(현재): 순수 fs 기반 JSON/JSONL 파일 저장. 어떤 Node/Electron 버전에서도, 어떤
//        OS에서도 무조건 동작한다. 채팅 기록은 세션당 많아야 몇만 줄 수준이라 SQLite
//        없이도 충분히 빠르다.
import fs from "fs";
import path from "path";
import type { BroadcastSession, ChatMessage, CategoryEvent, RestEvent, VisionEvent } from "./types";

// 기본은 컴파일된 위치(dist/store.js) 기준 프로젝트 루트의 data/. 다만 Electron 설치판
// (app.asar 안)에서는 이 기준으로 계산한 경로가 읽기 전용 아카이브 안이라 쓰기가 아예 안
// 되므로(수집된 채팅/이벤트가 통째로 저장 안 됨), gui/main.js가 실제 쓰기 가능한 위치
// (app.getPath("userData"))를 CHZZK_DATA_ROOT 환경변수로 먼저 심어두면 그 값을 대신 쓴다.
// CLI(`node dist/index.js`) 실행 시에는 이 환경변수가 없어서 예전과 동일하게 프로젝트
// 루트를 그대로 쓴다. config.ts와 같은 기준(CHZZK_DATA_ROOT)을 쓰지만, 모듈이 서로 값을
// 공유하지 않고 각자 process.env에서 읽어서 동일하게 계산한다 — 순환 의존을 피하기 위함.
const DATA_ROOT = process.env.CHZZK_DATA_ROOT || path.join(__dirname, "..");
const DATA_DIR = path.join(DATA_ROOT, "data");

function sessionMetaPath(sessionId: string): string {
  return path.join(DATA_DIR, `${sessionId}.session.json`);
}

function messagesPath(sessionId: string): string {
  return path.join(DATA_DIR, `${sessionId}.messages.jsonl`);
}

function eventsPath(sessionId: string): string {
  return path.join(DATA_DIR, `${sessionId}.events.jsonl`);
}

function restEventsPath(sessionId: string): string {
  return path.join(DATA_DIR, `${sessionId}.rest.jsonl`);
}

function visionEventsPath(sessionId: string): string {
  return path.join(DATA_DIR, `${sessionId}.vision.jsonl`);
}

export class Store {
  constructor() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  startSession(session: Omit<BroadcastSession, "endedAt">) {
    const full: BroadcastSession = { ...session, endedAt: null };
    fs.writeFileSync(sessionMetaPath(session.sessionId), JSON.stringify(full), "utf-8");
    // 메시지는 방송 내내 한 줄씩 append로 쓰기 때문에, 시작 시점에 빈 파일을 만들어둔다.
    fs.writeFileSync(messagesPath(session.sessionId), "", "utf-8");
    fs.writeFileSync(eventsPath(session.sessionId), "", "utf-8");
    fs.writeFileSync(restEventsPath(session.sessionId), "", "utf-8");
    fs.writeFileSync(visionEventsPath(session.sessionId), "", "utf-8");
  }

  /** 카테고리 변경 감지 등 타임라인 구간 나누기에 쓰이는 이벤트를 한 줄씩 append. */
  addCategoryEvent(sessionId: string, event: CategoryEvent) {
    fs.appendFileSync(eventsPath(sessionId), JSON.stringify(event) + "\n", "utf-8");
  }

  getCategoryEvents(sessionId: string): CategoryEvent[] {
    const p = eventsPath(sessionId);
    if (!fs.existsSync(p)) return [];
    const content = fs.readFileSync(p, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as CategoryEvent);
  }

  /** 로컬 화면 변화 감지로 확정한 휴식 시작/종료 이벤트를 한 줄씩 append. */
  addRestEvent(sessionId: string, event: RestEvent) {
    fs.appendFileSync(restEventsPath(sessionId), JSON.stringify(event) + "\n", "utf-8");
  }

  getRestEvents(sessionId: string): RestEvent[] {
    const p = restEventsPath(sessionId);
    if (!fs.existsSync(p)) return [];
    const content = fs.readFileSync(p, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RestEvent);
  }

  /** Claude 비전 API로 화면을 직접 판단한 결과를 한 줄씩 append (선택 기능, API 키 있을 때만 쌓임). */
  addVisionEvent(sessionId: string, event: VisionEvent) {
    fs.appendFileSync(visionEventsPath(sessionId), JSON.stringify(event) + "\n", "utf-8");
  }

  getVisionEvents(sessionId: string): VisionEvent[] {
    const p = visionEventsPath(sessionId);
    if (!fs.existsSync(p)) return [];
    const content = fs.readFileSync(p, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as VisionEvent);
  }

  endSession(sessionId: string, endedAt: number) {
    const session = this.getSession(sessionId);
    if (!session) return;
    session.endedAt = endedAt;
    fs.writeFileSync(sessionMetaPath(sessionId), JSON.stringify(session), "utf-8");
  }

  insertMessage(msg: ChatMessage) {
    // JSON Lines: 메시지 하나당 한 줄. DB 없이도 스트리밍하듯 계속 이어붙일 수 있어서
    // 방송 내내 채팅을 실시간으로 저장하는 이 용도에 잘 맞는다.
    fs.appendFileSync(messagesPath(msg.sessionId), JSON.stringify(msg) + "\n", "utf-8");
  }

  getSession(sessionId: string): BroadcastSession | undefined {
    const p = sessionMetaPath(sessionId);
    if (!fs.existsSync(p)) return undefined;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as BroadcastSession;
  }

  getMessages(sessionId: string): ChatMessage[] {
    const p = messagesPath(sessionId);
    if (!fs.existsSync(p)) return [];
    const content = fs.readFileSync(p, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ChatMessage);
  }

  close() {
    // 파일 기반이라 닫을 커넥션이 없다. 이전 SQLite 버전과 호출부(collector.ts) 호환을
    // 위해 메서드만 남겨둔다.
  }
}
