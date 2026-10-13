import type { SettingMeta } from "./kit/catalog";

const GUIDE = "What each device field does";

/** Every setting on the Devices tab, for the page's search (see kit/catalog.ts). Same words as the blocks. */
export const DEVICES_SETTINGS: SettingMeta[] = [
  {
    id: "device-name",
    tab: "devices",
    section: GUIDE,
    title: "Device name",
    purpose: "The name HR sees for this machine everywhere in the portal.",
    keywords: ["biometric", "machine", "add device", "rename", "punching"],
  },
  {
    id: "device-type",
    tab: "devices",
    section: GUIDE,
    title: "Device type",
    purpose:
      "A label for the machine's model, shown beside its name. It does not change how the portal talks to the machine: every machine is read with the ZKTeco protocol, and every machine that pushes uses the same ADMS push.",
    keywords: ["model", "zkteco", "essl", "aiface", "biometric"],
  },
  {
    id: "device-address",
    tab: "devices",
    section: GUIDE,
    title: "Host / IP address and port",
    purpose:
      "Where the server (or its Site Connector) connects to read this machine's punches: its network address and TCP port. An empty port means 4370, the ZKTeco default.",
    keywords: ["ip", "host", "port", "4370", "network", "address", "sync"],
  },
  {
    id: "device-comm-password",
    tab: "devices",
    section: GUIDE,
    title: "Comm password",
    purpose: "The machine's Comm Key, needed to open the reading connection. Usually 0; digits only.",
    keywords: ["comm key", "password", "zkteco", "authentication"],
  },
  {
    id: "device-serial",
    tab: "devices",
    section: GUIDE,
    title: "Serial number",
    purpose:
      "Ties the punches and heartbeats the machine sends by itself (ADMS push) to this entry: a pushing machine identifies itself only by its serial number. Two devices cannot share one.",
    keywords: ["serial", "sn", "adms", "push", "cloud server", "unknown sender"],
  },
  {
    id: "device-connect-via",
    tab: "devices",
    section: GUIDE,
    title: "Connect via",
    purpose:
      "Who talks to the machine: the server itself, or a Site Connector (a small Windows service on a computer inside the factory network) when the server cannot reach it.",
    keywords: ["site connector", "connector", "factory network", "lan", "remote"],
  },
  {
    id: "device-notes",
    tab: "devices",
    section: GUIDE,
    title: "Notes",
    purpose: "A free note for HR about this machine, such as where it hangs or who looks after it.",
    keywords: ["notes", "memo", "device"],
  },
  {
    id: "device-enabled",
    tab: "devices",
    section: GUIDE,
    title: "Enable or disable a device",
    purpose: "Takes a machine out of the portal's reading and checks, or back into them, without deleting it.",
    keywords: ["disable", "enable", "switch off", "power", "inactive"],
  },
  {
    id: "device-remove",
    tab: "devices",
    section: GUIDE,
    title: "Remove a device",
    purpose:
      "Deletes the device entry for good, with its cached list of device users and its connection-check history.",
    keywords: ["delete", "remove", "device"],
  },
];
