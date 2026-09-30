# Cross-Fleet layout bindings: specification for upstream review

Published export of the SpeciFlow-coordinated OpenSpec change `cross-fleet-layout-bindings` (planning revision `4a216c2`). This document is a review copy, not a second planning store.

# Proposal

## Why

Последний опубликованный Fleet поддерживает layout и локальные exact-instance bindings, но отклоняет участников из другого Fleet. Для сценария issue [#194](https://github.com/adapt-toolkit/ours-fleet/issues/194) нужно подключать общих специалистов под другим OS-пользователем, сохраняя их сессии и управление у исходного Fleet.

## What Changes

- Расширить существующий `layout create --bindings` явными ссылками на экземпляры другого Fleet на том же хосте и общем daemon/Cowork.
- Добавить выдаваемое владельцем разрешение на один точный standalone-экземпляр: проверка, вступление в комнату и доставка контекста комнаты.
- Предоставить `layout share` и `layout revoke-binding`; разрешение не даёт управление lifecycle или доступ к browser-console API.
- Сохранить нынешние фабрики для unbound-участников, idempotent membership, archive-preserving close и остановку только созданных layout экземпляров.

## Capabilities

### New Capabilities

- `cross-fleet-layout-bindings`: заимствование точного standalone-экземпляра другого Fleet через разрешённый владельцем membership-порт.

### Modified Capabilities

Нет: в выбранном OpenSpec пока нет канонических capability specs.

## Impact

База: Fleet **1.2.0-nightly.22**, commit `769fba35bc2918e792c353d2234d0fe5e2a48f57`; Cowork **1.3.3-nightly.20260926.ceab465**, commit `ceab465bdfe5c2aeb55987aac680f7a0ab0c5227`. Это опубликованные npm nightly, а не более поздний неопубликованный Git HEAD.

Меняются instance reference, layout CLI/native supervisor и существующий HTTP server Fleet. Cowork использует действующий management API; патч Cowork и новые зависимости не требуются.

## Non-Goals

Изменение очередности или длительности беседы, новый coordinator/service, discovery Fleet, cross-host транспорт и миграция старого `room create`/RoomTemplate API не входят в это предложение. Иллюстративный API из старого issue заменён уже появившимся layout API по текущей задаче пользователя. Отдельный ранее подготовленный `instance_scope`-патч сюда не включён. Установка в рабочее окружение и обновление пакетов не выполняются.


---

# Design

## Context

См. proposal.md. Текущий layout сохраняет borrowed-экземпляры с `owned: false`, проверяет launch/CID/session через native supervisor и использует Cowork для membership и архива. Локальный exact-instance control уже отклоняет остановленные и room-owned экземпляры. Прямой доступ Fleet A к приватному UDS/каталогу Fleet B под другим OS-пользователем невозможен и не нужен.

## Goals / Non-Goals

**Goals:** сохранить один Architect для Product/Design, один Developer для Design/Delivery и одного ProcessDoctor для всех трёх комнат при независимых room briefing/history и исходном lifecycle Fleet B.

**Non-Goals:** общая административная авторизация Fleet, список чужих агентов, запуск/остановка/перенастройка, перенос identity, автоматический retry неопределённых мутаций, новый runtime или отдельный HTTP service.

## Decisions

### Existing HTTP server and per-instance capability

Fleet B использует уже существующий `web serve`. Владелец вызывает `layout share <agent> [--temporary] --participant <key> --server-url <origin> --output <file>`. Команда проверяет live standalone instance и создаёт binding YAML с соседним приватным token-файлом; вывод содержит только grant ID и путь. В существующем Fleet state сохраняется запись с SHA-256 digest, instance и daemon UUID. Файлы создаются только при отсутствии назначения, с owner-only permissions.

Разрешение — явное делегирование membership и context delivery. Общие browser cookie/session, daemon credential, profile и private UDS не передаются. Существующий HTTP API получает узкий POST `/api/v1/layout-bindings/:id/control`, авторизуемый только отдельным bearer capability. Он не принимает `inspect`, `spawn`, `retire` или произвольные действия.

Альтернатива с общим master-token дала бы чужому Fleet ненужный lifecycle control. Доступ через chmod приватного UDS нарушил бы разделение OS-пользователей. Дополнительный relay/service усложнил бы установку. Capability на существующем сервере сохраняет нужную границу с минимальным транспортным дополнением.

### Explicit transferable binding

Владелец явно передаёт YAML и token-файл нужному OS-пользователю существующим безопасным способом. Credential copy принадлежит получателю и имеет mode 0600. Относительный путь разрешается относительно bindings YAML. Результат `layout create` хранит ссылку на файл, но не token.

```yaml
architect:
  supervisor: /owner-fleet-private-state
  agent: Architect
  temporary: true
  launch: exact-launch-id
  cid: exact-identity-cid
  session: exact-harness-session-id
  remote:
    url: http://127.0.0.1:49272
    grant_id: 11111111-1111-4111-8111-111111111111
    credential_file: architect.binding.yaml.token
    daemon_instance_id: 22222222-2222-4222-8222-222222222222
```

Первый поддержанный сценарий — разные OS-пользователи одного хоста с одним daemon и Cowork. Literal `127.0.0.1` HTTP origin обязателен, redirects и forwarded/non-loopback requests отвергаются. Клиент и владелец проверяют тот же daemon UUID. Remote metadata не уходит в локальный exact-instance control; возвращённая proof должна совпасть с полной исходной instance reference.

### Owner lifecycle stays authoritative

Для `join` caller передаёт room ID/CID/role, а не invite. Fleet B проверяет существующую provisioning/active комнату через общий Cowork и сам выпускает one-time room invite через его authenticated management API. Поэтому обычный contact invite не может быть redeemed даже при корректном grant. Перед каждым действием и подтверждением Fleet B проверяет исходный экземпляр через имеющийся exact-instance control. `assign` дополнительно проверяет active Cowork room CID и active seat ожидаемой identity/role. Закрытие room/layout не отзывает grant и не останавливает borrowed instance. После принятия результата владелец Fleet B сам останавливает standalone temporary agents действующими lifecycle-командами. `revoke-binding` отзывает дальнейший доступ, оставляя agent и действующие memberships живыми.

### Existing uncertainty semantics

Ответ после внешнего действия может потеряться. Layout сохраняет существующий `uncertain` cursor до допуска/доставки контекста и не повторяет неизвестную мутацию автоматически. Ошибки remote транспорта возвращаются без чужих body/секретов. Исправление или reconciliation остаётся нынешним ручным workflow.

## Risks / Trade-offs

- [Grant позволяет приглашать конкретного агента и передавать room context] → только явная выдача владельцем доверенному создателю комнат; exact-instance fence, active seat validation и revocation.
- [Fleet B HTTP server недоступен] → явная ошибка без spawn fallback; keep existing web server доступным на время layout-операций.
- [Lost response] → durable uncertain marker и отсутствие blind replay.
- [Native close прекращает active membership, но сохраняет архив] → архив проверяется через Cowork management history, а не participantHistory для active seat.

## Migration Plan

Новых зависимостей и изменения старых layout YAML не требуется. Сначала поставить Fleet-патч на оба Fleet, использовать тот же выбранный daemon/Cowork, затем владелец экспортирует явные bindings. Старые snapshots и local bindings сохраняют поведение. Откат выполняется после закрытия remote layout или отказа от дальнейших операций над ним; старый Fleet отвергает remote bindings. Рабочая установка в этой задаче не меняется.

## Verification

Проверки Fleet покрывают три комнаты, exact-session reuse, idempotency, close без borrowed retirement, private credential handling, invalid/revoked/stale references, daemon mismatch, active seat gate, browser authority separation и lost-response fencing. Проверки исходников Cowork выбранного nightly подтверждают admission, management auth и archive-preserving close. Полный запуск реальных harnesses под двумя OS-пользователями не выдаётся за выполненный тест; это отдельная среда приёмки upstream, а не новая функциональность.


---

# Spec Delta

## Purpose

Позволить создавать независимые Cowork-комнаты из layout с общими standalone-специалистами другого Fleet, сохраняя точные экземпляры, сессии и исходное управление lifecycle.

## ADDED Requirements

### Requirement: Explicit owner-authorized cross-Fleet binding

Fleet SHALL принимать launch-time binding на точный live standalone temporary или persistent экземпляр другого Fleet при разных OS-пользователях одного хоста, общем daemon/Cowork и явном разрешении владельца. Instance reference MUST идентифицировать supervisor, agent, lifetime, launch, CID и harness session.

#### Scenario: Three-room topology with shared specialists

- **WHEN** Fleet A открывает Product с Architect/Doctor, Design с Architect/Developer/Doctor и Delivery с Developer/Doctor из разрешённых bindings Fleet B
- **THEN** в трёх комнатах используются исходные три live экземпляра с прежними CID/session; duplicate agents не создаются и room briefing/history остаются независимыми.

#### Scenario: Mixed factories and bindings

- **WHEN** только часть участников layout имеет bindings
- **THEN** только unbound-участники создаются из своих factories; bound-экземпляры сохраняют brain, permissions, persona, working directory и supervision Fleet B.

### Requirement: Membership authority without foreign lifecycle control

Выданное разрешение SHALL позволять только verify, join и assign для одной exact instance reference. Оно MUST NOT разрешать inventory inspection, spawn, stop/retire, reconfiguration, identity export или browser-console authentication. До join MUST быть проверены room ID и CID в общем Cowork и получено приглашение самим владельцем через authenticated Cowork room API; caller-supplied invite, неизвестная или closing/closed комната MUST отклоняться до contact/membership mutation. Перед доставкой контекста MUST существовать active Cowork room с ожидаемым CID и active seat экземпляра в ожидаемой роли.

#### Scenario: Holder attempts lifecycle control

- **WHEN** обладатель binding передаёт inspect, spawn, retire или использует capability для browser-console API
- **THEN** запрос отклоняется без lifecycle effects на Fleet B.

#### Scenario: Ordinary contact invite or invalid room target

- **WHEN** holder передаёт обычный contact invite, неизвестную/closing/closed комнату или другой room CID
- **THEN** запрос отвергается до выпуска room invite и обращения к agent contact mutation.

#### Scenario: Assignment outside active membership

- **WHEN** room отсутствует, закрыта, имеет другой CID или у экземпляра нет active seat ожидаемой роли
- **THEN** контекст не передаётся агенту.

### Requirement: Exact-instance validation and explicit refusal

Binding SHALL проверяться до external room mutations и перед действиями над экземпляром. Остановленный, replaced, room-owned, unproven, revoked или transport-unavailable binding MUST давать ошибку без silent replacement. Другой daemon, неподдержанный origin или изменившаяся proof MUST отклоняться.

#### Scenario: Replaced session or revoked grant

- **WHEN** исходная harness session заменена либо владелец отозвал grant
- **THEN** последующая операция с прежним binding завершается ошибкой, новый агент не запускается.

#### Scenario: Unsupported transport or different daemon

- **WHEN** binding указывает non-loopback origin, redirect или другой daemon instance
- **THEN** binding отвергается; административный доступ чужого Fleet не запрашивается.

### Requirement: Protected credential export and revocation

Владелец SHALL экспортировать binding и отдельный owner-only credential file без вывода token в stdout. Запись авторизации SHALL содержать только token digest. Snapshot, ошибки и обычный API output MUST NOT раскрывать credential value. Revocation SHALL прекращать дальнейшие разрешённые операции без остановки агента или удаления действующих membership.

#### Scenario: Export, transfer and revoke

- **WHEN** владелец экспортирует binding, получатель читает собственную mode-0600 credential copy, а затем владелец отзывает grant
- **THEN** token не появляется в YAML/snapshot/stdout; новые операции отказывают, существующий agent/session остаётся живым.

### Requirement: Independent rooms and original lifecycle ownership

Borrowed instances SHALL иметь `owned: false` и SHALL переживать закрытие одной комнаты и всего layout. Close SHALL сохранять native Cowork history. Только original Fleet SHALL явно завершать standalone temporary specialists после принятия результата.

#### Scenario: Close Product

- **WHEN** Product закрыта при ещё активных Design/Delivery
- **THEN** Architect остаётся доступен в Design, Doctor — в Design/Delivery, identities и session state сохранены.

#### Scenario: Complete project

- **WHEN** после business acceptance закрыты все три комнаты и layout
- **THEN** история сохранена, borrowed agents живы; original Fleet может явно завершить каждый temporary экземпляр один раз.

### Requirement: Idempotency and uncertain mutation fencing

Повторное открытие active комнаты SHALL проверять исходные memberships без повторной доставки контекста. При неизвестном результате join/assign SHALL сохраняться durable uncertain marker; повторная операция MUST требовать reconciliation, а не повторять неизвестную мутацию.

#### Scenario: Repeat and lost response

- **WHEN** active room повторно открывается либо ответ потерян после фактического join
- **THEN** в первом случае membership/context не дублируются; во втором cursor остаётся неопределённым и blind retry не выполняется.


---
