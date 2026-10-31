King of Thieves TAS (Phantom-Frida + Waydroid) — гайд по запуску на CachyOS
===========================================================================

Этот документ описывает установку зависимостей и запуск программы `main.py` (Frida-агент для игры King of Thieves) на хосте с CachyOS, при этом игра работает внутри контейнера Waydroid.

**Особенность сборки:** Используется пропатченный сервер `phantom-frida` (собранный под именем `sysmon` на порту `41337`), чтобы скрыть следы от анти-чит систем.

1\. Предварительные требования
------------------------------

*   **CachyOS** (или любой Arch-based дистрибутив).
    
*   **Waydroid** уже установлен, инициализирован и запущен.
    
*   **Root-доступ внутри Waydroid** (через `su`). Frida-серверу нужны права root для внедрения в процесс игры.
    
*   **Игра King of Thieves** установлена внутри Waydroid.
    
*   Скачанный файл `sysmon-server-17.16.4-android-x86_64` (пропатченный сервер).
    

2\. Установка системных пакетов
-------------------------------

Откройте терминал на хосте (CachyOS).

```bash
sudo pacman \-Syu
sudo pacman \-S android-tools python python-pip
```

*   `android-tools` предоставляет `adb`, необходимый для связи с Waydroid.
    
*   `python` и `python-pip` понадобятся для установки Frida.
    

3\. Подключение ADB к Waydroid
------------------------------

Для подключения к Waydroid обычно достаточно `waydroid adb connect`. Но если нужно, то узнать точный IP можно в настройках Waydroid: Settings → About → IP address, либо командой::

```bash
sudo waydroid shell ip addr show eth0
```
Выполните подключение (замените IP, если он отличается):

```bash
adb connect 192.168.240.112:5555
```
Проверьте, что устройство видно (должно появиться `... device`):

```bash
adb devices
```
4\. Установка и запуск Phantom-Frida (sysmon)
---------------------------------------------
Скачайте исходники пропатченной frida (sysmon)
https://github.com/NoortZee/phantom-frida/releases/tag/x86

Убедитесь, что вы находитесь в папке, куда скачали `sysmon`. Внутри Android (Waydroid) файлы лучше всего хранить в `/data/local/tmp/`.

1.  **Загрузите бинарник в Waydroid:**
    
```bash
    adb push sysmon-server-17.16.4-android-x86\_64 /data/local/tmp/sysmon
```
2.  **Дайте права на выполнение:**
    
    ```bash
    adb shell "su -c 'chmod 755 /data/local/tmp/sysmon'"
    ```
    
3.  **Запустите сервер от имени root в фоне (на порту 41337):**
    
    ```bash
 adb shell "su -c '/data/local/tmp/sysmon -l unix:/data/local/tmp/sysmon.sock &'"
adb forward tcp:41337 localabstract:/data/local/tmp/sysmon.sock
    ```
    
    _Проверить, что процесс жив: `adb shell "su -c 'ps -A | grep sysmon'"`_
    
4.  **Пробросьте порт на хост (CachyOS):**  
    Чтобы скрипт на Python мог достучаться до сервера, пробрасываем порт:
    
    ```bash
    adb forward tcp:41337 tcp:41337
    ```

5\. Настройка Python-окружения и установка Frida
------------------------------------------------

Так как мы используем пропатченный сервер `phantom-frida`, версия клиента на хосте **обязана** строго совпадать с версией сервера (`17.16.4`).

Создайте отдельное виртуальное окружение в папке проекта (например, `~/memory_replay`):

```bash
cd ~/memory_replay
python3 \-m venv venv-phantom
venv-phantom/bin/pip install \--upgrade pip
venv-phantom/bin/pip install frida\==17.16.4 frida-tools
```
Проверьте, что подключение к серверу работает (команда должна вывести список процессов Android, включая игру):

```bash
./venv-phantom/bin/frida-ps \-H 127.0.0.1:41337
```

6\. Запуск программы
--------------------

Убедитесь, что ADB-подключение к Waydroid активно, сервер `sysmon` запущен, а порт проброшен.

Запускайте скрипт **строго через окружение `venv-phantom`**:

```bash
cd ~/memory_replay
./venv-phantom/bin/python3 \-u main.py
```
Эта команда запускает интерактивный режим. Следуйте подсказкам в терминале:

*   `Enter` / `rehearse` — запись + воспроизведение.
    
*   `record` — только запись лога.
    
*   `play` — только воспроизведение ранее записанного лога.
    
*   `clear` — удалить лог.
    
*   `exit / q` — выход.
    

7\. Возможные проблемы и решения
--------------------------------

### `frida-ps` не подключается (unable to connect)

*   Убедитесь, что `sysmon` запущен внутри Waydroid: `adb shell "su -c 'ps -A | grep sysmon'"`.
    
*   Проверьте, что проброшен unix-сокет: `adb forward --list` (должна быть строка `tcp:41337 localabstract:/data/local/tmp/sysmon.sock`)
    
*   Перезапустите сервер: `adb shell "su -c 'pkill sysmon'"`, затем запустите снова.
    

### `frida-ps -U` не показывает процессы (для старой версии)

В текущей конфигурации мы не используем `-U`, так как подключаемся через `add_remote_device` и `-H 127.0.0.1:41337`.

### Игра не запускается или падает при attach

Данный TAS использует **attach** к уже запущенному процессу, а не **spawn**. Это обходит известную проблему с таймаутом spawn в Waydroid. Убедитесь, что игра уже запущена и находится на экране уровня (в «замороженном» состоянии), прежде чем начинать запись.
