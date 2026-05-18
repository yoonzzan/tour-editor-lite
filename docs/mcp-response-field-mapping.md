# MCP 응답 ↔ 일정표 UI 매핑 정의

이 문서는 `AVP999260602VNE` 샘플 응답 기준으로,
`MCP` 응답 값을 현재 편집기 화면(ItineraryData)에 어떻게 반영하는지 정의한다.
실제 매핑 구현은 `src/lib/mcp/mapSaleProductToItinerary.ts`에서 수행한다.

## 1. 기본 규칙

- 소스 우선 탐색: `payload` / `result` / `content` / `data` / root
- 필드 선택은 코드에서 `pickFirstString`, `pickFirstNumber`, `pickFirstRecord`, `pickFirstArray`로 대체 키 탐색
- 값이 없으면 빈 문자열/0/기본값으로 보정
- 날짜는 `YYYY-MM-DD`로 정규화
- 금액은 문자열 숫자(`"610,000"`)도 숫자로 파싱

## 2. 화면 모델 매핑

- 대상 화면 모델: `ItineraryData`
  - `header`
  - `overview`
  - `basics`
  - `days`

### 2-1) header

| 화면 필드 | MCP 응답 경로 | 비고 |
|---|---|---|
| `header.groupName` | `data.baseProductInfo.saleProdNm` | 없음 시 `productName/name` 또는 `fallbackCode` 사용 |
| `header.writtenAt` | `header.writtenAt` or `header.createdAt` | 없으면 현재일(`CURRENT_DATE`) |

### 2-2) overview

| 화면 필드 | MCP 응답 경로 | 변환/조합 규칙 |
|---|---|---|
| `overview.recipient` | `overview.recipient` 계열 | 없으면 `root.recipientName` 계열 또는 빈 값 |
| `overview.cities` | `data.baseProductInfo.itnrCntyCds`, `vistCity`, `prodAreaCd` | `schdInfoList`의 도시 후보와 병합 후 유니크 조합 |
| `overview.travelPeriod.start` | `baseProductInfo.depDay` | `period.start` 우선, 미수신 시 기본 시작일 사용 |
| `overview.travelPeriod.end` | `baseProductInfo.arrDay` | `period.end` 우선, 미수신 시 시작일 보정 |
| `overview.passengers.adult` | `data.baseProductInfo.adtCnt` | 숫자 미수신 시 0 |
| `overview.passengers.child` | `data.baseProductInfo.chdCnt` | 숫자 미수신 시 0 |
| `overview.passengers.infant` | `data.baseProductInfo.infCnt` | 숫자 미수신 시 0 |
| `overview.passengers.escort` | `data.baseProductInfo.escortCnt` | 숫자 미수신 시 0 |
| `overview.fare.adultPerPerson` | `baseProductInfo.adtTotlAmt`, fallback `adultTotalPerPerson`, `adtAmt`, `adultPerPerson`, `adtTaduAmt` | 성인 1인 총 상품가 우선, 미수신 시 0 |
| `overview.fare.childPerPerson` | `baseProductInfo.chdTotlAmt`, fallback `childTotalPerPerson`, `chdAmt`, `childPerPerson`, `chdTaduAmt` | 아동 1인 총 상품가 우선, 미수신 시 0 |
| `overview.fare.infantPerPerson` | `baseProductInfo.infTotlAmt`, fallback `infantTotalPerPerson`, `infAmt`, `infantPerPerson`, `infTaduAmt` | 유아 1인 총 상품가 우선, 미수신 시 0 |
| `overview.fare.total` | `baseProductInfo.adtTotlAmt` | 미수신 시 `total` 또는 파생 값 사용 |
| `overview.fare.totalWithCard` | `baseProductInfo.totalWithCard` | 미수신 시 `total`과 동일 |
| `overview.singleCharge` | `baseProductInfo.snglAddAmt` | 빈 값이면 0 |

### 2-3) basics

| 화면 필드 | MCP 응답 경로 | 변환/조합 규칙 |
|---|---|---|
| `basics.flight.departure` | `baseProductInfo.depCityNm`, `baseProductInfo.depFlgtCd` | `도시 / 항공편코드` 형태로 조합 |
| `basics.flight.arrival` | `baseProductInfo.arrCityNm`, `baseProductInfo.arrFlgtCd` | `도시 / 항공편코드` 형태로 조합 |
| `basics.flight.localVehicle` | `baseProductInfo.airCityExprYn` 또는 `airSeatClpsnCnt` | 우선순위 순으로 탐색 |
| `basics.accommodation.hotel` | `itineraryInfo.schdInfoList[].htlInfoList[].htlKoNm|htlEnNm` | 일차별 호텔명을 모두 수집해 중복 제거 후 결합 |
| `basics.accommodation.grade` | `baseProductInfo.htlEnn` | 그대로 사용 |
| `basics.accommodation.occupancy` | `baseProductInfo.chdInclRoomYn` | 그대로 사용 |
| `basics.included` | `baseProductInfo.trvlExpnInclList` | `trvlExpnDesc` 내용만 결합. `[제세금]`, `[여행자보험]`, `[가이드/기사]` 같은 `trvlExpnClstNm` 구분자 prefix는 표시하지 않음 |
| `basics.excluded` | `baseProductInfo.trvlExpnNoneInclList` 또는 `trvlNoneInclList` | `trvlExpnDesc` 내용만 결합. `trvlExpnClstNm` 구분자 prefix는 표시하지 않음 |
| `basics.optionalTour` | `baseProductInfo.trvlChcExpnList.corePntTitlNm` 계열 | 텍스트 결합 후 중복 제거 |
| `basics.shoppingCenters` | `baseProductInfo.shpnCntrVistCnt` | 숫자화 후 최대 0 이상 보정 |
| `basics.notes` | `baseProductInfo.noteTrvlInfo.noteTrvlRmkCont`, `baseProductInfo.noteResInfo.noteResRmkCont`, `scheduleAndTouristSpotInfo.optiontourRemarksInfo.remarkData*` | 각 문자열을 정규화/병합, 빈 값 제거, ` | `로 결합 |

### 2-4) days

| 화면 필드 | MCP 응답 경로 | 변환/조합 규칙 |
|---|---|---|
| `days[].dayNo` | `itineraryInfo.schdInfoList[].schdSeq` | 미수신 시 index + 1 |
| `days[].date` | `itineraryInfo.schdInfoList[].strtDt` | 날짜 형식 정규화 실패 시 이전 날짜 연속 증가(1일) |
| `days[].items[].id` | schedule item별 고유키 | 기본 `item-{dayNo}-{idx}` 생성 |
| `days[].items[].type` | `schdCatgCd`, `schdCatgNm` | `002→TRANSFER`, `004→MEAL`, `001/005/007→SIGHTSEEING`, `099/102→OTHER`, 기타 문자열 힌트 매핑 |
| `days[].items[].content` | `memoTitlNm`, `cardNm`, `memoCont`, `cardCntntPc`, `cardCntntMbl` | 순서대로 결합, html 제거/공백 정규화 후 축약 |
| `days[].items[].region` | `region`, `area`, `place`, `depCityNm`, `arrCityNm` | 우선순위 탐색 |
| `days[].items[].time` | `schdRqrmTm`, `schdRqrmHm` | `HH:mm` 정규화 |
| `days[].items[].transport` | `depCityNm→arrCityNm` 또는 `depFlgtCd/arrFlgtCd` | `002` 이동에서 출발/도착 병합 시 `A → B` |
| `days[].items[].meal` | `mealTypeNm`, `dtlMealDvNm`, `mealCont`, `cardCntnt*` | 조식/중식/석식 파싱 후 `{ breakfast/lunch/dinner }` 형태 저장 |
| `days[].items[].mealSlot` | `mealTypeNm` / `dtlMealNm` | 단일 슬롯 힌트만 저장 |
| `days[].items[].hotel` | `htlInfoList`(자동 삽입 항목) | `X`일차 호텔 정보로 자동 생성 | 

### 2-5) 호텔 자동 삽입 항목

- `itineraryInfo.schdInfoList[].htlInfoList` 가 존재하면 각 호텔을 별도 `ACCOMMODATION` 아이템으로 추가한다.
- 형식: `"{호텔명} 숙박"`

## 3. 샘플 응답에서 현재 미반영(매핑 미사용) 항목

`baseProductInfo`와 세부 일정엔 다음 항목이 다수 존재하나, 화면/일정표 모델은 현재 사용하지 않음.

- 브랜드/속성: `prodBrndCd`, `brndNm`, `attrTitl`, `prodChrctrCd`, `prodTypeCd` 등
- 가격 상세: `bafInclYn`, `fuelExchgAmt`, `ljoin*`, `dnpyTlAmt`, `teamDvCd`, `usrPrdrvAllNoc` 등
- 항공/좌석 상태: `frdmSchdDvCd`, `airSeatClpsnCnt`, `airUseYn` 등 일부는 `localVehicle` 문자열에만 간헐 반영
- 쇼핑/환불 상세: `shpnAtntMtr`, `prcGdncBcVo` 상세 객체
- 메모 보강: `guidInfo`, `tcInfo`, `airInvInfo`, `cityBasInfoList`의 상세, `pkgAirSeatCntInfo` 등
- 일정 상세: `touristSpotInfo`, `cmsInfoList`, `pkgCmsImgInfoList`, 이미지 URL, 다중 카테고리/카드 메타데이터 등은 기본 화면 입력으로 반영되지 않음

## 4. 향후 확장 제안

- 미반영 필드를 화면에 노출해야 하면 `ItineraryData` 확장 후 매핑 파일도 같이 업데이트
- 매핑 추가 시 아래 우선순위 준수: 기존 UI 렌더링 영향 최소화, 데이터 보존(backward-compatible) 유지

## 5. 적용 파일

- 매핑 로직: `src/lib/mcp/mapSaleProductToItinerary.ts`
- 타입: `src/types/index.ts`
