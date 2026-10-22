# 🚕 taxi-meter

Claude Code mod. 현재 모델·컨텍스트 사용량·API 환산 요금을 한국 택시미터기처럼 프롬프트 위에 띄운다.

- 차종 = 모델 (Fable은 검정·금색 모범택시)
- 컨텍스트 80% 초과 시 할증 표시
- API 요금(USD)을 원화로 환산 (기본 1,400원/달러)

## 설치

```
/plugin marketplace add purisia/claude-mods
/plugin install taxi-meter@purisia
```

## 명령

| 명령 | 설명 |
|---|---|
| `/taxi` | 켜기·끄기 전환 (`/taxi on`, `/taxi off`) |
| `/taxi-rate 1385` | 환율 보기·바꾸기 |

환율 기본값은 `/plugin configure taxi-meter@purisia`에서도 바꿀 수 있다.
