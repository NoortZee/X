Полный гайд запуска TAS King of Thieves (Phantom + Frida, async)
================================================================

**Стек:** Frida-агент (только чтение) + Phantom (тапы через `InputManager`) + Waydroid + King of Thieves x86\_64.

Все команды — из **fish shell** на хосте (CachyOS/Arch), если не указано «внутри Android».

***

0\. Что должно быть готово
--------------------------

```fish
# Waydroid запущен
waydroid status

# adb видит Waydroid
adb devices
# ожидаем: 192.168.240.112:5555    device

# игра установлена
adb shell pm list packages | grep thieves
# package:com.zeptolab.thieves.google

# root внутри Waydroid работает
sudo waydroid shell -- id
# uid=0(root)
```
Если что-то не так — `waydroid session start`, `adb connect 192.168.240.112:5555`, установка APK через `waydroid app install`.

***

1\. Зависимости (один раз)
--------------------------

```fish
sudo pacman -S --needed python python-pip jdk-openjdk android-tools

# AUR-пакеты Android SDK
yay -S --needed android-sdk-platform-tools android-sdk-build-tools android-platform

# Проверка, что android.jar и d8 на месте
ls /opt/android-sdk/platforms/*/android.jar
ls /opt/android-sdk/build-tools/*/d8
```
**Python-окружение:**

```fish
mkdir -p ~/memory_replay/{logs,tests}
cd ~/memory_replay
python3 -m venv venv-phantom
./venv-phantom/bin/pip install --upgrade pip
./venv-phantom/bin/pip install frida==17.16.4 frida-tools pyyaml pytest
```

**Проверка:**

```fish
./venv-phantom/bin/python -c "import frida, yaml; print(frida.__version__)"
# 17.16.4
```

**Переменные для сборки** (добавьте в `~/.config/fish/config.fish`, чтобы не повторять):

```fish
set -gx ANDROID_JAR /opt/android-sdk/platforms/android-37.0/android.jar
set -gx D8 /opt/android-sdk/build-tools/37.0.0/d8
```
***

2\. Патч и сборка `phantom-server.jar` (один раз)
-------------------------------------------------

### 2.1. Клон Phantom и правка `injectInputEvent`

```fish
cd ~
git clone https://github.com/oliviermugishak/phantom.git
cd ~/phantom/contrib/android-server
```
Открыть `src/com/phantom/server/PhantomServer.java`, проверить что:

```java
private static final int INJECT\_INPUT\_EVENT\_MODE\_ASYNC \= 0;
```
**Если там что-то другое - заменить на** 

(или `sed` ниже):

```java
private static final int INJECT\_INPUT\_EVENT\_MODE\_ASYNC \= 0;
```
> **Важно:** оставляем `ASYNC = 0`. `WAIT_FOR_RESULT` (1) и `WAIT_FOR_FINISH` (2) **зависают** на frozen-уровне → Android убивает процесс → все последующие тапы уходят в чёрную дыру.

Если константа была `WAIT_FOR_*` — жёсткий патч:

```fish
sed -i -E 's/INJECT_INPUT_EVENT_MODE_(WAIT_FOR_RESULT|WAIT_FOR_FINISH)/INJECT_INPUT_EVENT_MODE_ASYNC/g' ~/phantom/contrib/android-server/src/com/phantom/server/PhantomServer.java
sed -i -E 's/(INJECT_INPUT_EVENT_MODE_ASYNC) *= *[12]/\1 = 0/' ~/phantom/contrib/android-server/src/com/phantom/server/PhantomServer.java
```
**Проверка:**

```fish
grep -n "INJECT_INPUT_EVENT_MODE" ~/phantom/contrib/android-server/src/com/phantom/server/PhantomServer.java
# 394:        private static final int INJECT_INPUT_EVENT_MODE_ASYNC = 0;
# 420:                    INJECT_INPUT_EVENT_MODE_ASYNC

grep -c "WAIT_FOR" ~/phantom/contrib/android-server/src/com/phantom/server/PhantomServer.java
# 0
```

### 2.2. Сборка

```fish
cd ~/phantom/contrib/android-server
rm -rf build classes
./build.sh
```

**Ожидаемо:**

```text
Using ANDROID_JAR=/opt/android-sdk/platforms/android-37.0/android.jar
Using D8_BIN=/opt/android-sdk/build-tools/37.0.0/d8
Built /home/noort/phantom/contrib/android-server/build/phantom-server.jar
```
Проверка jar:

```fish
unzip -l build/phantom-server.jar | grep classes.dex
# classes.dex должен быть, размер ~10000
```
Запомните md5:

```fish
md5sum build/phantom-server.jar
```
### 2.3. Разложить jar

```fish
# Staged для daemon (не обязательно, но пусть будет)
sudo cp build/phantom-server.jar ~/.local/share/phantom/android/phantom-server.jar
sudo chown $USER:$USER ~/.local/share/phantom/android/phantom-server.jar

# Android
adb push build/phantom-server.jar /data/local/tmp/phantom-server.jar
sudo waydroid shell -- chmod 644 /data/local/tmp/phantom-server.jar

# Проверка
sudo waydroid shell -- md5sum /data/local/tmp/phantom-server.jar
md5sum build/phantom-server.jar
# Должны совпасть
```

***

3\. Sysmon (Frida) — установка (один раз)
-----------------------------------------

```fish
# Залить бинарник (файл sysmon-server-17.16.4-android-x86_64 из phantom-frida releases)
adb push sysmon-server-17.16.4-android-x86_64 /data/local/tmp/sysmon
sudo waydroid shell -- chmod 755 /data/local/tmp/sysmon

# Запустить
sudo waydroid shell -- setsid nohup /data/local/tmp/sysmon -l unix:/data/local/tmp/sysmon.sock >/data/local/tmp/sysmon.log 2>&1 < /dev/null &
sleep 2

# Проверка
sudo waydroid shell -- ps -A | grep sysmon
# ожидаем: <pid> root ... sysmon
```
***

4\. Файлы проекта
-----------------

Все файлы — в `~/memory_replay/`. Полные листинги:

`agent.js` — v5.4 (strict FRAME\_FUNC resolver, lazy pump, FPS-оптимизация, JUMP monitor)
    
`main.py` — v6.1 (lazy `ensure_pump`, `do_record`/`do_play`/`do_calibrate`)
    
`orchestrator.py` — v7.0 (async + JUMP-hook + retry)
    
`phantom_bridge.py` — TCP-клиент Phantom
    
`config.yaml` — конфиг
    

**`config.yaml`:**

```yaml
phantom:
  host: "127.0.0.1"
  port: 27183
  connect_timeout_ms: 2000
  ping_timeout_ms: 1000
  sync_mode: "async"
  tap_down_to_up_ms: 1
  post_tap_wait_ms: 0
  slot: 0
  reconnect_attempts: 1

tap:
  position: "explicit"
  x: 540
  y: 960

orchestrator:
  nominal_fps: 60
  predict_lead_ms: 0
  predict_margin_ms: 0
  poll_interval_ms: 5
  post_tap_check_ms: 150
  retry_on_miss: true
  retry_delay_ms: 50
  fire_hard_deadline_s: 15
  wall_timeout_s: 300
  verify_body_frames: false

frida:
  device: "127.0.0.1:41337"
  package: "com.zeptolab.thieves.google"

logging:
  level: "INFO"
  log_dir: "logs"
```
> **`tap.x/y`** — координаты зоны прыжка. `(540, 960)` — центр экрана для 1080×1920. Проверьте `adb shell wm size` и скорректируйте.

***

5\. Запуск стека (каждый раз после перезагрузки)
------------------------------------------------

### 5.1. ADB

```fish
adb kill-server
adb start-server
adb connect 192.168.240.112:5555
adb devices
# ожидаем: 192.168.240.112:5555    device
```
### 5.2. Sysmon (Frida)

```fish
sudo waydroid shell -- pkill -9 -f sysmon 2>/dev/null

adb shell "su -c '/data/local/tmp/sysmon -l unix:/data/local/tmp/sysmon.sock &'"
```
```fish
sudo waydroid shell -- ps -A | grep sysmon
# ожидаем: <pid> root ... sysmon
```
### 5.3. Phantom-server — **в отдельном терминале (foreground)**

**Терминал 1** (не закрывать):

```fish
sudo waydroid shell -- pkill -9 -f com.phantom.server.PhantomServer 2>/dev/null
sleep 1
sudo waydroid shell -- env CLASSPATH=/data/local/tmp/phantom-server.jar /system/bin/app_process /system/bin com.phantom.server.PhantomServer --host 0.0.0.0 --port 27183
```
**Ожидаемо:** `phantom-server starting host=0.0.0.0 port=27183` и **команда не возвращается** (сервер работает).

> **Не** используйте `&` внутри `waydroid shell -- sh -c '... &'` — процесс умрёт при выходе `sh`. Только foreground в отдельном терминале, либо `phantom --daemon` (Вариант B ниже).

**Вариант B** — если не хотите держать терминал: `phantom --daemon`:

```fish
sudo pkill -f "phantom --daemon" 2>/dev/null
sudo -E phantom --daemon > /tmp/phantom-daemon.log 2>&1 &
sleep 3
tail -20 /tmp/phantom-daemon.log
# INFO launching android touch server ...
# INFO connected to android touch server ...
```

**Минус B:** daemon держит своё соединение к серверу. Если тапы перестанут работать — `sudo pkill -f "phantom --daemon"` перед `main.py`.

### 5.4. Проверка, что сервер жив

**Терминал 2:**

```fish
sudo waydroid shell -- ps -A | grep PhantomServer
# ожидаем: <pid> root ... app_process

sudo waydroid shell -- netstat -tlnp 2>/dev/null | grep 27183
# LISTEN 27183
```

### 5.5. Forward портов (оба!)

```fish
adb forward tcp:41337 localabstract:/data/local/tmp/sysmon.sock
adb forward tcp:27183 tcp:27183
adb forward --list
# должно быть ДВЕ строки:
#   tcp:41337 localabstract:/data/local/tmp/sysmon.sock
#   tcp:27183 tcp:27183
```
> **`adb kill-server` сносит оба forward.** После любого `adb kill-server` — восстановить.

### 5.6. Проверка Frida

```fish
cd ~/memory_replay
./venv-phantom/bin/frida-ps -H 127.0.0.1:41337 | grep thieves
# com.zeptolab.thieves.google должен быть в списке
```

### 5.7. Smoke-тест Phantom

```fish
./venv-phantom/bin/python -c "
from phantom_bridge import PhantomBridge
p = PhantomBridge({'host':'127.0.0.1','port':27183,'sync_mode':'async',
    'tap_down_to_up_ms':1,'post_tap_wait_ms':0,'slot':0,
    'connect_timeout_ms':2000,'ping_timeout_ms':500,'reconnect_attempts':1})
p.connect()
import time
for i in range(3):
    print(i, p.tap(540, 960)); time.sleep(0.8)
"
```
**Главный критерий:** персонаж **прыгает 3 раза**. `duration_ms ≈ 1.1 ms` — это норма (клиент не ждёт сервер, `sync_mode=async`).

Если не прыгает — см. «Диагностика» ниже.

***

6\. Работа — `main.py`
----------------------

```fish
cd ~/memory\_replay
./venv-phantom/bin/python -u main.py
```
**Ожидаемый старт:**

```text
INFO main: attached by name: King of Thieves
INFO main: [agent] {'type': 'module_base', ...}
INFO main: [agent] {'type': 'detect_installed', 'n': 3}
─────────────────────────────────────────────────
  Enter / rehearse  ...
  ```
> **`pump_installed` при старте отсутствует** — это **правильно**. `pump_install` ленивый, вызывается только когда нужно (в record/play). Idle FPS не падает.

### 6.1. Record

```text
\> record
```
1.  Войдите в уровень (персонаж **frozen**).
    
2.  Enter.
    
3.  **Один тап** по экрану → уровень стартует → сыграйте 3–15 прыжков.
    
4.  Enter — стоп.
    

**Ожидаемый лог:**

```text
INFO main: [agent] {'type': 'jump_monitor_installed', ...}
INFO main: [agent] {'type': 'pump_installed', 'offset': '0x1612a20'}
INFO main: [agent] {'type': 'detect_started', 'frame': 0}
...
INFO main: [agent] {'type': 'detect_stopped',
                    'body_frames': 918, 'avg_fps': '44.7'}
INFO main: saved replay: 17 events, 918 body_frames, anchor=first_hero_update@1
```
**Три критерия валидной записи:**

`offset: 0x1612a20` (не `0x161b7c0`)
    
`body_frames > 0`
    
`avg_fps ≥ 35`
    

Если `body_frames = 0` — хук на неправильной функции, см. «Диагностика».

### 6.2. Play

```text
\> play
```

1.  Войдите в уровень (frozen).
    
2.  Enter.
    
3.  **Один тап** → уровень стартует → orchestrator шлёт тапы по плану.
    

**Ожидаемый лог:**

```text
INFO orch: playSetup: anchor=first\_hero\_update@1 jumps=15
INFO orch: tap position: (540, 960)
INFO orch: fire idx=0 cur=4 target=4 frames\_to\_go=0 tap=(540,960)
INFO orch: fired idx=0 fired@4 target=4 err=+0 tap=1.10ms taps=1
...
✅ jumps: 15/15 (missed=0)
 frame\_error: min=0 med=0 max=0 abs\_med=0 abs\_max=0
 report: logs/play\_YYYYMMDD\_HHMMSS.json
```

**Критерии успеха:**

`jumps_fired == jumps_planned`
    
`missed == 0`
    
`err == 0` на всех прыжках (в async допускается ±1 на части прыжков — не критично)
    

Полный отчёт: `logs/play_*.json` → `fired_log[]` содержит `idx, abs_frame, target_frame, frame_error, tap_ack_ms, tap_count, snap_before, snap_after`.

***

7\. Диагностика проблем
-----------------------

### 7.1. `attach failed: unable to connect to remote frida-server`

Слетел `adb forward tcp:41337` или sysmon убит.

```fish
sudo waydroid shell -- ps -A | grep sysmon
# если пусто — заново:
sudo waydroid shell -- setsid nohup /data/local/tmp/sysmon -l unix:/data/local/tmp/sysmon.sock >/data/local/tmp/sysmon.log 2>&1 < /dev/null &
sleep 2

# forward
adb forward tcp:41337 localabstract:/data/local/tmp/sysmon.sock
./venv-phantom/bin/frida-ps -H 127.0.0.1:41337 | grep thieves
```

### 7.2. `phantom_bridge: connect failed: [Errno 111]`

Не проброшен `tcp:27183` или phantom-server мёртв.

```fish
adb forward tcp:27183 tcp:27183
sudo waydroid shell -- ps -A | grep PhantomServer
sudo waydroid shell -- netstat -tlnp | grep 27183
```

Если сервер мёртв — снова Шаг 5.3 (foreground в терминале 1).

### 7.3. `FRAME_FUNC AOB mismatch`

В логе: `'aob_offset': '0x161b7c0', 'expected_offset': '0x1612a20'`. **Это норма** — strict resolver отбросил ложный AOB-матч и взял правильный fallback. `pump_installed.offset` **должен быть** `0x1612a20`.

Если `pump_installed.offset` **другой** — agent.js старый, перезаписать v5.4.

### 7.4. `body_frames: 0` после record

Хук на неправильной функции. Проверить `pump_installed.offset`. Если не `0x1612a20` — agent.js не v5.4.

### 7.5. Все тапы MISSED в play

Три варианта:

**A. jar с `WAIT_FOR_*`.** Проверить исходник:

```fish
grep -n "INJECT_INPUT_EVENT_MODE" ~/phantom/contrib/android-server/src/com/phantom/server/PhantomServer.java
```

Должно быть `ASYNC = 0`. Если `WAIT_FOR_*` — вернуться к Шагу 2.

**B. phantom-server завис.** Проверить лог:

```fish
sudo waydroid shell -- cat /data/local/tmp/phantom-server.log
```

Если после `starting` ничего и `ps` показывает процесс с большим `etime` (часы) — старый висит, убить и запустить заново.

**C. Неверные координаты.** Ручной тест:

```fish
adb shell input tap 540 960
```

Если `input tap` прыгает, а `phantom.tap` нет — jar старый или `WAIT_FOR_*`.

### 7.6. `adb shell` висит

`pkill -9 -f "^app_process"` матчит **свой** su-wrapper → зацикливается. Используйте анкор:

```fish
sudo waydroid shell -- pkill -9 -f com.phantom.server.PhantomServer
sudo waydroid shell -- pkill -9 -f "^app_process"
```

Если `adb shell` всё равно висит:

```fish
pkill -9 -f "adb.*shell"
adb kill-server
adb start-server
adb connect 192.168.240.112:5555
```

### 7.7. `device offline`

```fish
adb kill-server
pkill -9 -f "adb"
sleep 2
adb start-server
adb connect 192.168.240.112:5555
adb devices
```

Если не помогло — перезапустить adbd внутри Android:

```fish
sudo waydroid shell -- sh -c 'setprop service.adb.tcp.port 5555; stop adbd; sleep 1; start adbd'
sleep 2
adb kill-server; adb start-server; adb connect 192.168.240.112:5555
```

### 7.8. FPS падает до 10–15 в record

Признак старого agent.js (без lazy install и оптимизаций). Убедиться, что agent.js — v5.4 (`grep -c "ensure_pump\|_ringActive"` должно быть ≥ 2).

***


8\. Чек-лист приёмки
--------------------

□
    `adb devices` → `device`  

□
    `frida-ps -H 127.0.0.1:41337` видит thieves

□
    `phantom-server starting ...` в foreground
    
□
    `netstat 27183` → LISTEN
    
□
    `adb forward --list` → **две** строки (41337 + 27183)
    
□
    smoke: 3 тапа → 3 прыжка
    
□
    `record`: `offset 0x1612a20`, `body_frames > 0`, `avg_fps ≥ 35`
    
□
    `play`: `missed=0`, `err=0` (или ±1)
    
□
    `logs/play_*.json` содержит `fired_log[]`
    
□
    Визуально персонаж проходит уровень так же, как при ручной игре
    

***

9\. Что делать при полном сбросе
---------------------------------

Если всё сломалось и непонятно, где:

```fish
# 1) ADB
adb kill-server; pkill -9 -f "adb"; sleep 2
adb start-server
adb connect 192.168.240.112:5555
adb devices

# 2) Полный рестарт Waydroid (потеряются все процессы)
waydroid session stop
sleep 5
waydroid session start
sleep 20

# 3) Всё по шагам 5.1–5.7
```

Если после рестарта Waydroid `sysmon` не найден — перезалить из `sysmon-server-17.16.4-android-x86_64` (Шаг 3).

Если `phantom-server.jar` упал при старте (пустой лог, `ps` пустой) — проверить `unzip -l` и пересобрать (Шаг 2.2).
