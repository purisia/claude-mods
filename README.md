# claude-mods

purisia의 Claude Code mod 모음.

## 설치

```
/plugin marketplace add purisia/claude-mods
/plugin install <mod 이름>@purisia
```

## mod 목록

| mod | 설명 |
|---|---|
| [taxi-meter](taxi-meter/) | 모델·컨텍스트 사용량·API 환산 요금(원화)·프로젝트·브랜치를 택시미터기처럼 프롬프트 위에 표시 |
| [project-tree](project-tree/) | 프로젝트 폴더를 오른쪽 탭에 트리로 표시, 검색, Claude가 만들고 고친 파일 표시, 파일·폴더 바로 열기 |

## mod 추가하기

1. `<mod 이름>/` 폴더에 `.claude-plugin/plugin.json`과 `hooks/`를 넣는다.
2. `.claude-plugin/marketplace.json`의 `plugins`에 `{ "name", "source": "./<mod 이름>", "description" }`을 추가한다.
3. 위 표에 한 줄 추가한다.

## 업데이트

```
/plugin marketplace update purisia
/plugin update taxi-meter@purisia
/reload-plugins
```
