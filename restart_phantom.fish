#!/usr/bin/env fish
# Восстановление рабочего состояния: Frida + manual phantom-server + forward.
# Запуск: fish restart_phantom.fish

set -l JAR_LOCAL ~/phantom_keymaper/contrib/android-server/build/phantom-server.jar
set -l JAR_DEVICE /data/local/tmp/phantom-server.jar
set -l JAR_STAGED ~/.local/share/phantom/android/phantom-server.jar

echo "== 1. Убить всё старое =="
sudo pkill -9 -f "phantom --daemon" 2>/dev/null
adb shell "su -c 'pkill -9 -f PhantomServer'" 2>/dev/null
adb shell "su -c 'pkill -9 -f app_process'" 2>/dev/null
sleep 2

echo "== 2. Залить jar =="
if test -f $JAR_LOCAL
    cp $JAR_LOCAL $JAR_STAGED
    adb push $JAR_LOCAL $JAR_DEVICE
    adb shell "su -c 'chmod 644 $JAR_DEVICE'"
else
    echo "WARN: $JAR_LOCAL не найден, использую staged в $JAR_STAGED"
    adb push $JAR_STAGED $JAR_DEVICE
    adb shell "su -c 'chmod 644 $JAR_DEVICE'"
end

echo "== 3. Запустить phantom-server (setsid = detach от pty) =="
adb shell "su -c 'setsid env CLASSPATH=$JAR_DEVICE app_process /system/bin com.phantom.server.PhantomServer --host 0.0.0.0 --port 27183 </dev/null >/data/local/tmp/phantom-server.log 2>&1 &'"
sleep 2

echo "== 4. Проверить =="
echo "-- процессы:"
adb shell "su -c 'ps -A -o pid,user,etime,cmd | grep app_process'"
echo "-- порт:"
adb shell "su -c 'netstat -tlnp 2>/dev/null | grep 27183'"
echo "-- лог:"
adb shell "su -c 'cat /data/local/tmp/phantom-server.log'"

echo "== 5. Forward =="
adb forward tcp:41337 localabstract:/data/local/tmp/sysmon.sock 2>/dev/null
adb forward tcp:27183 tcp:27183
adb forward --list | grep -E "41337|27183"

echo "== 6. Smoke =="
cd ~/memory_replay
./venv-phantom/bin/python -c "
from phantom_bridge import PhantomBridge
p = PhantomBridge({'host':'127.0.0.1','port':27183,'sync_mode':'async',
    'tap_down_to_up_ms':1,'post_tap_wait_ms':0,'slot':0,
    'connect_timeout_ms':2000,'ping_timeout_ms':500,'reconnect_attempts':1})
p.connect(); print('phantom OK:', p.tap(540, 960))
"
