

King of Thieves TAS (Frida + Waydroid) — гайд по запуску на CachyOS
===================================================================

Этот документ описывает установку зависимостей и запуск программы `main.py` (Frida-агент для игры King of Thieves) на хосте с CachyOS, при этом игра работает внутри контейнера Waydroid.

1\. Предварительные требования
------------------------------

*   **CachyOS** (или любой Arch-based дистрибутив).
    
*   **Waydroid** уже установлен, инициализирован и запущен.
    
*   **Root-доступ внутри Waydroid** (через `su`). Frida-серверу нужны права root для внедрения в процесс игры. Процесс получения root не входит в этот гайд.
    
*   **Игра King of Thieves** установлена внутри Waydroid.
    

2\. Установка системных пакетов
-------------------------------

Откройте терминал на хосте (CachyOS).

```bash
sudo pacman \-Syu
sudo pacman \-S android-tools python python-pip
```
*   `android-tools` предоставляет `adb`, необходимый для связи с Waydroid.
    
*   `python` и `python-pip` понадобятся для установки Frida.
    

3\. Настройка Python-окружения и установка Frida
------------------------------------------------

Создайте виртуальное окружение в папке проекта (рекомендуется) и установите `frida-tools`.

```bash
cd /путь/к/папке/с/проектом   \# например, ~/memory\_replay
python3 \-m venv .venv
source .venv/bin/activate
pip install \--upgrade pip
pip install frida-tools
```
Проверьте версию Frida (она понадобится для выбора frida-server):

```bash
frida \--version
```
Запомните выведенную версию (например, `17.9.1`).

4\. Подключение ADB к Waydroid
------------------------------

Для подключения к Waydroid обычно достаточно  `waydroid adb connect`.
Но если нужно, то узнать точный IP можно в настройках Waydroid: **Settings → About → IP address**, либо командой:

```bash
sudo waydroid shell ip addr show eth0
```
Выполните подключение (замените IP, если он отличается):

```bash
adb connect 192.168.240.112:5555
```
Проверьте, что устройство видно:

```bash
adb devices
```
В списке должно появиться `192.168.240.112:5555 device`.

> **Примечание:** Если `adb connect` не срабатывает, попробуйте `192.168.240.1:5555` или перезапустите сессию Waydroid (`waydroid session stop`, затем снова запустите).

5\. Установка и запуск frida-server внутри Waydroid
---------------------------------------------------

Frida-сервер должен соответствовать архитектуре Android-контейнера (Waydroid обычно **x86\_64**) и версии клиента Frida.

1.  **Скачайте frida-server** с официального GitHub-релиза. Подставьте свою версию (из шага 3):
    
    ```bash
    wget https://github.com/frida/frida/releases/download/17.9.1/frida-server-17.9.1-android-x86\_64.xz
    unxz frida-server-17.9.1-android-x86\_64.xz
    ```
    
2.  **Загрузите бинарник в Waydroid** и дайте права на выполнение:
    
    ```bash
    adb push frida-server-17.9.1-android-x86\_64 /data/local/tmp/frida-server
    adb shell "su -c 'chmod 755 /data/local/tmp/frida-server'"
    ```
    
3.  **Запустите frida-server от имени root** (в фоне):
    
   ```bash
    adb shell "su -c '/data/local/tmp/frida-server &'"
  ```

   > `adb shell "su -c 'nohup /data/local/tmp/frida-server > /dev/null 2>&1 &'"`.
    
4.  **Проверьте соединение**:
    
    ```bash
    frida-ps \-U
    ```
Если команда выводит список процессов Waydroid, сервер работает и клиент его видит. [[1]](https://vix-w1zzer.gitbook.io/vixwizzer/notes/android-applications/dynamic-analysis-with-waydroid)
    

6\. Запуск программы
--------------------

Убедитесь, что вы находитесь в виртуальном окружении (`.venv` активирован) и ADB-подключение к Waydroid активно.

```bash
.venv/bin/python3 \-u main.py 
```

Эта команда запускает интерактивный режим: сначала запись событий и состояния тела, затем воспроизведение прыжков. Следуйте подсказкам в терминале.

режимы:

*   `record` — только запись лога.
    
*   `play` — только воспроизведение ранее записанного лога.

*   `clear` — удалить лог.
    
*   `exit / q` — выход.
    

7\. Возможные проблемы и решения
--------------------------------

### `frida.get_usb_device()` не находит устройство

В `main.py` используется `frida.get_usb_device(timeout=5)`. В некоторых конфигурациях Waydroid Frida может не определить устройство как «USB». Если вы видите ошибку подключения, замените в `main.py` строку:

```python
device \= frida.get\_usb\_device(timeout\=5)
```
на:

```python
device \= frida.get\_device\_manager().add\_remote\_device('192.168.240.112:5555')
```
(укажите ваш IP-адрес Waydroid). Метод `add_remote_device` принудительно подключается к удалённому frida-server по указанному адресу и часто решает проблемы с обнаружением.

### `frida-ps -U` не показывает процессы

*   Убедитесь, что `frida-server` запущен с правами root (`su -c`). Без root он не сможет работать.
    
*   Проверьте, что версии клиента и сервера совпадают (шаг 5).
    
*   Перезапустите `frida-server` и повторите `adb connect`.
    

### Игра не запускается или падает при attach

Данный TAS использует **attach** к уже запущенному процессу, а не **spawn**. Это обходит известную проблему с таймаутом spawn в Waydroid. Убедитесь, что игра уже запущена и находится на экране уровня (в «замороженном» состоянии), прежде чем начинать запись. [[2]](https://github.com/frida/frida/issues/3605)

