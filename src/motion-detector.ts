// 휴식(자리비움) 감지를 위한 순수 로직 모듈. I/O가 전혀 없는 계산만 하기 때문에 외부 API
// 호출 비용이 0원이다 — 화면 변화량(frame-classifier.ts가 캡처)을 이 모듈이 해석해서
// "휴식중" 판단의 신호로 쓴다(collector.ts).
//
// 왜 채팅량이 아니라 화면 변화량을 보는가: 스트리머가 자리를 비웠을 때 채팅이 항상 조용해
// 지는 게 아니다(오히려 "어디감?" 같은 채팅으로 더 늘 수도 있음). 반면 화면은 사람이 자리에
// 없으면 대체로 그대로 멈춰있을 가능성이 높아서, 훨씬 직접적인 신호다.
//
// 왜 고정 임계값이 아니라 "최근 평균 대비 상대적으로" 판단하는가: 게임마다 원래 화면이
// 얼마나 움직이는지가 완전히 다르다. 액션 게임은 항상 격하게 움직이고, 턴제/비주얼노벨류는
// 플레이 중에도 원래 거의 안 움직인다. 고정 임계값 하나로는 어느 한쪽에서 반드시 오탐/누락이
// 생기기 때문에, 그 방송 자체의 최근 변화량을 기준선으로 삼는다.

// 아래 세 값은 "기본값"이다. 실제로 쓰는 값은 MotionTracker 생성 시 넘기는 옵션(없으면 이
// 기본값)이고, GUI "고급 설정"에서 사용자가 config.json에 바꿔 저장하면 collector.ts가 그
// 값을 읽어 넘겨준다 (src/config.ts의 DEFAULT_ANALYSIS_SETTINGS 참고 — 값 자체는 거기서도
// 동일하게 중복 정의돼 있으니, 여기 기본값을 바꾸면 그쪽도 같이 맞춰야 한다).
export const ABS_FLOOR = 2; // 0~255 스케일에서 이 값 미만 차이는 인코딩 노이즈로 보고 무시
export const RELATIVE_FACTOR = 0.25; // 최근 평균 변화량의 25% 미만이면 "이번 틱은 정적"으로 봄
export const ROLLING_WINDOW = 20; // 평균 계산에 쓰는 최근 샘플 개수

export interface MotionObservation {
  diff: number;
  isStatic: boolean;
  rollingAvg: number;
  staticStreak: number; // 이 관찰까지 포함해서 연속으로 "정적"이었던 횟수
}

export interface MotionTrackerOptions {
  absFloor?: number;
  relativeFactor?: number;
  rollingWindow?: number;
}

export class MotionTracker {
  private history: number[] = [];
  private staticStreak = 0;
  private absFloor: number;
  private relativeFactor: number;
  private rollingWindow: number;

  constructor(opts: MotionTrackerOptions = {}) {
    this.absFloor = opts.absFloor ?? ABS_FLOOR;
    this.relativeFactor = opts.relativeFactor ?? RELATIVE_FACTOR;
    this.rollingWindow = opts.rollingWindow ?? ROLLING_WINDOW;
  }

  /** 새로 캡처한 프레임의 변화량(frameDiffScore 결과)을 관찰하고 판단 결과를 돌려준다. */
  observe(diff: number): MotionObservation {
    // 기준선은 "이번 샘플을 넣기 전까지의" 평균이어야 한다. 이번 값 자체를 평균에 먼저
    // 섞어버리면, 정적인 구간이 길어질수록 기준선도 같이 낮아져서 "정적" 판정을 영영
    // 벗어날 수 없게 되는(자기 자신을 기준으로 스스로를 정당화하는) 문제가 생긴다.
    const rollingAvg =
      this.history.length > 0 ? this.history.reduce((a, b) => a + b, 0) / this.history.length : diff;
    const threshold = Math.max(this.absFloor, rollingAvg * this.relativeFactor);
    const isStatic = diff < threshold;

    this.staticStreak = isStatic ? this.staticStreak + 1 : 0;

    this.history.push(diff);
    if (this.history.length > this.rollingWindow) this.history.shift();

    return { diff, isStatic, rollingAvg, staticStreak: this.staticStreak };
  }

  /** Claude 확인 결과 "휴식 아님"으로 판명되거나, 휴식이 확정된 직후 연속 카운트만 리셋한다
   * (기준선 계산에 쓰는 history는 그대로 유지 — 그 방송의 평소 변화량 감각은 유지해야 하니까). */
  resetStreak(): void {
    this.staticStreak = 0;
  }

  /**
   * 지금 기준선(rolling average) 기준으로 이 diff 값이 "정적"인지만 읽기 전용으로 확인한다.
   * observe()와 달리 history/staticStreak을 전혀 바꾸지 않는다 - "휴식 의심" 뜬 직후 짧은
   * 간격으로 몰아서 재확인(버스트 체크)할 때 쓰는데, 이 버스트 간격은 평소 정기 체크 주기와
   * 성격이 달라서(훨씬 촘촘함) 그 diff를 그대로 기준선에 섞으면 기준선이 왜곡될 수 있다.
   */
  isLikelyStatic(diff: number): boolean {
    const rollingAvg =
      this.history.length > 0 ? this.history.reduce((a, b) => a + b, 0) / this.history.length : diff;
    const threshold = Math.max(this.absFloor, rollingAvg * this.relativeFactor);
    return diff < threshold;
  }
}
