// factory-power: tells the factory daemon when this Mac is about to sleep and when it woke.
// Built by `factory service install` (clang, no Xcode project) into <FACTORY_HOME>/bin/.
//
//   stdout: "sleep" on kIOMessageSystemWillSleep, "wake" on kIOMessageSystemHasPoweredOn
//   stdin:  "done" releases the held sleep; so does EOF (the daemon died; the helper then exits)
//
// Sleep is held with the IOKit power-management hold: the system waits for IOAllowPowerChange
// (up to about 30 s) before it sleeps. This helper acks on "done", or by itself after
// 25 s, so a stuck daemon never keeps the Mac awake. kIOMessageCanSystemSleep (idle sleep
// asking permission) is always allowed: the factory never vetoes a sleep.
#include <IOKit/IOKitLib.h>
#include <IOKit/pwr_mgt/IOPMLib.h>
#include <IOKit/IOMessage.h>
#include <CoreFoundation/CoreFoundation.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static io_connect_t root_port;
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static int pending = 0;        // a sleep is being held
static long pending_arg = 0;   // its notification id
static unsigned long epoch = 0;// which hold a timeout belongs to

static void release(unsigned long only_epoch) {
  pthread_mutex_lock(&mu);
  if (pending && (only_epoch == 0 || only_epoch == epoch)) {
    pending = 0;
    IOAllowPowerChange(root_port, pending_arg);
  }
  pthread_mutex_unlock(&mu);
}

static void *timeout_thread(void *arg) {
  sleep(25);
  release((unsigned long)arg);
  return NULL;
}

static void *stdin_thread(void *unused) {
  char line[64];
  while (fgets(line, sizeof line, stdin)) if (strncmp(line, "done", 4) == 0) release(0);
  release(0); // EOF: the daemon is gone, so this helper goes too
  _exit(0);
}

static void power_cb(void *ref, io_service_t svc, natural_t msg, void *arg) {
  switch (msg) {
    case kIOMessageCanSystemSleep:
      IOAllowPowerChange(root_port, (long)arg);
      break;
    case kIOMessageSystemWillSleep: {
      pthread_mutex_lock(&mu);
      pending = 1; pending_arg = (long)arg; epoch++;
      unsigned long mine = epoch;
      pthread_mutex_unlock(&mu);
      puts("sleep"); fflush(stdout);
      pthread_t t; pthread_create(&t, NULL, timeout_thread, (void *)mine); pthread_detach(t);
      break;
    }
    case kIOMessageSystemHasPoweredOn:
      puts("wake"); fflush(stdout);
      break;
  }
}

int main(void) {
  IONotificationPortRef port; io_object_t notifier;
  root_port = IORegisterForSystemPower(NULL, &port, power_cb, &notifier);
  if (!root_port) { fputs("factory-power: IORegisterForSystemPower failed\n", stderr); return 1; }
  CFRunLoopAddSource(CFRunLoopGetCurrent(), IONotificationPortGetRunLoopSource(port), kCFRunLoopCommonModes);
  pthread_t t; pthread_create(&t, NULL, stdin_thread, NULL); pthread_detach(t);
  puts("ready"); fflush(stdout);
  CFRunLoopRun();
  return 0;
}
