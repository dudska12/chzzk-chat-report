#!/usr/bin/env node
// kiwi-nlp(한국어 형태소 분석기)용 모델 파일을 내려받는 "선택적" 설치 스크립트.
//
// 이 스크립트를 실행하지 않아도 프로그램은 정상 동작한다 — src/kiwi-tokenizer.ts가
// models/kiwi/ 폴더가 없으면 조용히 정규식 기반 단어 추출로 폴백하기 때문이다.
// 실행하면 "자주 나온 단어"가 조사/어미 없이 훨씬 깔끔한 명사 위주로 나온다.
//
// 모델 파일은 설치된 kiwi-nlp npm 패키지와 같은 버전의 GitHub 릴리즈에서 받아온다.
// (버전이 달라지면 wasm 바이너리와 모델 포맷이 안 맞을 수 있어서 버전을 맞춤)
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const MODEL_DIR = path.join(ROOT, "models", "kiwi");
const REQUIRED_FILES = [
  "combiningRule.txt",
  "default.dict",
  "extract.mdl",
  "multi.dict",
  "sj.knlm",
  "sj.morph",
  "skipbigram.mdl",
  "typo.dict",
];

function getKiwiVersion() {
  const pkgPath = path.join(ROOT, "node_modules", "kiwi-nlp", "package.json");
  if (!fs.existsSync(pkgPath)) {
    console.error("kiwi-nlp가 설치돼 있지 않습니다. 먼저 `npm install`을 실행하세요.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version;
}

function download(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          file.close();
          fs.unlinkSync(destPath);
          if (redirectsLeft <= 0) return reject(new Error("리다이렉트가 너무 많습니다."));
          resolve(download(res.headers.location, destPath, redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          reject(new Error(`다운로드 실패: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
      })
      .on("error", reject);
  });
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

async function main() {
  const version = getKiwiVersion();
  const url = `https://github.com/bab2min/Kiwi/releases/download/v${version}/kiwi_model_v${version}_base.tgz`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiwi-model-"));
  const tgzPath = path.join(tmpDir, "model.tgz");

  console.log(`kiwi-nlp 버전: ${version}`);
  console.log(`모델 다운로드 중: ${url}`);
  console.log("(파일 크기가 수십~백 MB라 시간이 좀 걸릴 수 있습니다)");

  try {
    await download(url, tgzPath);
  } catch (err) {
    console.error("다운로드 실패:", err.message);
    console.error(
      `직접 다운로드해서 압축을 푼 다음, 아래 파일들을 ${MODEL_DIR} 폴더에 넣어주세요:\n  ${REQUIRED_FILES.join(
        ", "
      )}\n다운로드 페이지: https://github.com/bab2min/Kiwi/releases`
    );
    process.exit(1);
  }

  console.log("압축 해제 중...");
  const extractDir = path.join(tmpDir, "extracted");
  fs.mkdirSync(extractDir);
  try {
    execFileSync("tar", ["-xzf", tgzPath, "-C", extractDir], { stdio: "inherit" });
  } catch (err) {
    console.error(
      "tar 명령을 찾을 수 없거나 압축 해제에 실패했습니다. Windows는 10(1803) 이상이면 기본 내장돼 있습니다."
    );
    throw err;
  }

  fs.mkdirSync(MODEL_DIR, { recursive: true });
  const missing = [];
  for (const name of REQUIRED_FILES) {
    const found = findFile(extractDir, name);
    if (!found) {
      missing.push(name);
      continue;
    }
    fs.copyFileSync(found, path.join(MODEL_DIR, name));
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (missing.length > 0) {
    console.error(`다음 모델 파일을 압축 안에서 찾지 못했습니다: ${missing.join(", ")}`);
    console.error(
      "Kiwi 배포 구조가 바뀌었을 수 있습니다. GitHub 릴리즈 페이지를 확인해주세요: https://github.com/bab2min/Kiwi/releases"
    );
    process.exit(1);
  }

  console.log(`완료! 모델 파일이 ${MODEL_DIR} 에 설치되었습니다.`);
  console.log('이제부터 리포트의 "자주 나온 단어"가 형태소 분석 기반으로 훨씬 정확해집니다.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
