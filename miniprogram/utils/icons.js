/**
 * 图标统一引用（由 scripts/gen-icons.js 生成，请勿手改）
 * - cloud: 云存储 cloud:// 文件 ID（统一引用，设计稿 SVG 源已上传 icons/ 目录）
 * - data:  base64 内联兜底（云存储不可达时自动降级，<app-icon> 组件处理）
 */
const ICONS = {
  "tab-home": {
    "off": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/tab-home-off.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNDOUNERDQiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMy41IDEwLjUgMTIgNGw4LjUgNi41Ii8+PHBhdGggZD0iTTUuNSA5LjVWMTlhMSAxIDAgMCAwIDEgMWgxMWExIDEgMCAwIDAgMS0xVjkuNSIvPjxwYXRoIGQ9Ik0xMCAyMHYtNWg0djUiLz48L3N2Zz4="
    },
    "on": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/tab-home-on.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMy41IDEwLjUgMTIgNGw4LjUgNi41Ii8+PHBhdGggZD0iTTUuNSA5LjVWMTlhMSAxIDAgMCAwIDEgMWgxMWExIDEgMCAwIDAgMS0xVjkuNSIvPjxwYXRoIGQ9Ik0xMCAyMHYtNWg0djUiLz48L3N2Zz4="
    }
  },
  "tab-timetable": {
    "off": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/tab-timetable-off.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNDOUNERDQiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSIzLjUiIHk9IjQuNSIgd2lkdGg9IjE3IiBoZWlnaHQ9IjE2IiByeD0iMiIvPjxwYXRoIGQ9Ik0zLjUgOS41aDE3Ii8+PHBhdGggZD0iTTggMi41djQiLz48cGF0aCBkPSJNMTYgMi41djQiLz48cGF0aCBkPSJNOS4yIDkuNVYyMCIvPjxwYXRoIGQ9Ik0xNC44IDkuNVYyMCIvPjwvc3ZnPg=="
    },
    "on": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/tab-timetable-on.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSIzLjUiIHk9IjQuNSIgd2lkdGg9IjE3IiBoZWlnaHQ9IjE2IiByeD0iMiIvPjxwYXRoIGQ9Ik0zLjUgOS41aDE3Ii8+PHBhdGggZD0iTTggMi41djQiLz48cGF0aCBkPSJNMTYgMi41djQiLz48cGF0aCBkPSJNOS4yIDkuNVYyMCIvPjxwYXRoIGQ9Ik0xNC44IDkuNVYyMCIvPjwvc3ZnPg=="
    }
  },
  "tab-duty": {
    "off": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/tab-duty-off.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNDOUNERDQiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSI1IiB5PSI0LjUiIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNi41IiByeD0iMiIvPjxwYXRoIGQ9Ik05IDQuNVYzaDZ2MS41Ii8+PHBhdGggZD0iTTkgMTMuNWwyLjIgMi4yTDE1LjUgMTEiLz48L3N2Zz4="
    },
    "on": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/tab-duty-on.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSI1IiB5PSI0LjUiIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNi41IiByeD0iMiIvPjxwYXRoIGQ9Ik05IDQuNVYzaDZ2MS41Ii8+PHBhdGggZD0iTTkgMTMuNWwyLjIgMi4yTDE1LjUgMTEiLz48L3N2Zz4="
    }
  },
  "tab-mine": {
    "off": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/tab-mine-off.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNDOUNERDQiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjgiIHI9IjMuOCIvPjxwYXRoIGQ9Ik00LjUgMjBjLjYtMy42IDMuNy01IDcuNS01czYuOSAxLjQgNy41IDUiLz48L3N2Zz4="
    },
    "on": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/tab-mine-on.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjgiIHI9IjMuOCIvPjxwYXRoIGQ9Ik00LjUgMjBjLjYtMy42IDMuNy01IDcuNS01czYuOSAxLjQgNy41IDUiLz48L3N2Zz4="
    }
  },
  "bell": {
    "orange": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/bell-orange.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGRjdEMDAiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNi41IDE2LjV2LTUuNGE1LjUgNS41IDAgMCAxIDExIDB2NS40bDEuNiAyLjNINC45eiIvPjxwYXRoIGQ9Ik0xMCAyMWg0Ii8+PC9zdmc+"
    },
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/bell-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNi41IDE2LjV2LTUuNGE1LjUgNS41IDAgMCAxIDExIDB2NS40bDEuNiAyLjNINC45eiIvPjxwYXRoIGQ9Ik0xMCAyMWg0Ii8+PC9zdmc+"
    },
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/bell-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNi41IDE2LjV2LTUuNGE1LjUgNS41IDAgMCAxIDExIDB2NS40bDEuNiAyLjNINC45eiIvPjxwYXRoIGQ9Ik0xMCAyMWg0Ii8+PC9zdmc+"
    }
  },
  "check-circle": {
    "green": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/check-circle-green.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMwMEI0MkEiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI4LjUiLz48cGF0aCBkPSJNOC4yIDEyLjRsMi42IDIuNiA1LTUuNCIvPjwvc3ZnPg=="
    }
  },
  "check": {
    "white": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/check-white.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNC41IDEyLjVsNSA1TDE5LjUgNyIvPjwvc3ZnPg=="
    },
    "green": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/check-green.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMwMEI0MkEiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNC41IDEyLjVsNSA1TDE5LjUgNyIvPjwvc3ZnPg=="
    }
  },
  "undo": {
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/undo-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM0RTU5NjkiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMy41IDQuNXY2aDYiLz48cGF0aCBkPSJNNS4yIDE1LjVhOCA4IDAgMSAwIDEtOC43TDMuNSAxMC41Ii8+PC9zdmc+"
    }
  },
  "calendar": {
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/calendar-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSIzLjUiIHk9IjQuNSIgd2lkdGg9IjE3IiBoZWlnaHQ9IjE2IiByeD0iMiIvPjxwYXRoIGQ9Ik0zLjUgOS41aDE3Ii8+PHBhdGggZD0iTTggMi41djQiLz48cGF0aCBkPSJNMTYgMi41djQiLz48L3N2Zz4="
    },
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/calendar-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSIzLjUiIHk9IjQuNSIgd2lkdGg9IjE3IiBoZWlnaHQ9IjE2IiByeD0iMiIvPjxwYXRoIGQ9Ik0zLjUgOS41aDE3Ii8+PHBhdGggZD0iTTggMi41djQiLz48cGF0aCBkPSJNMTYgMi41djQiLz48L3N2Zz4="
    }
  },
  "calendar-check": {
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/calendar-check-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSIzLjUiIHk9IjQuNSIgd2lkdGg9IjE3IiBoZWlnaHQ9IjE2IiByeD0iMiIvPjxwYXRoIGQ9Ik0zLjUgOS41aDE3Ii8+PHBhdGggZD0iTTggMi41djQiLz48cGF0aCBkPSJNMTYgMi41djQiLz48cGF0aCBkPSJNOSAxNS41bDIgMiA0LTQuMiIvPjwvc3ZnPg=="
    },
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/calendar-check-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSIzLjUiIHk9IjQuNSIgd2lkdGg9IjE3IiBoZWlnaHQ9IjE2IiByeD0iMiIvPjxwYXRoIGQ9Ik0zLjUgOS41aDE3Ii8+PHBhdGggZD0iTTggMi41djQiLz48cGF0aCBkPSJNMTYgMi41djQiLz48cGF0aCBkPSJNOSAxNS41bDIgMiA0LTQuMiIvPjwvc3ZnPg=="
    }
  },
  "people": {
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/people-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSI5IiBjeT0iOC41IiByPSIzLjUiLz48cGF0aCBkPSJNMi44IDE5LjVjLjUtMy4yIDMuMS00LjUgNi4yLTQuNXM1LjcgMS4zIDYuMiA0LjUiLz48Y2lyY2xlIGN4PSIxNi44IiBjeT0iOS41IiByPSIyLjYiLz48cGF0aCBkPSJNMTcuNSAxNC42YzIuNC40IDMuOCAxLjcgNC4yIDMuOSIvPjwvc3ZnPg=="
    },
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/people-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSI5IiBjeT0iOC41IiByPSIzLjUiLz48cGF0aCBkPSJNMi44IDE5LjVjLjUtMy4yIDMuMS00LjUgNi4yLTQuNXM1LjcgMS4zIDYuMiA0LjUiLz48Y2lyY2xlIGN4PSIxNi44IiBjeT0iOS41IiByPSIyLjYiLz48cGF0aCBkPSJNMTcuNSAxNC42YzIuNC40IDMuOCAxLjcgNC4yIDMuOSIvPjwvc3ZnPg=="
    }
  },
  "plus": {
    "white": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/plus-white.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgNXYxNCIvPjxwYXRoIGQ9Ik01IDEyaDE0Ii8+PC9zdmc+"
    },
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/plus-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgNXYxNCIvPjxwYXRoIGQ9Ik01IDEyaDE0Ii8+PC9zdmc+"
    }
  },
  "arrow-right": {
    "light": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/arrow-right-light.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNDOUNERDQiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNOSA1LjUgMTUuNSAxMiA5IDE4LjUiLz48L3N2Zz4="
    },
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/arrow-right-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNOSA1LjUgMTUuNSAxMiA5IDE4LjUiLz48L3N2Zz4="
    }
  },
  "arrow-left": {
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/arrow-left-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM0RTU5NjkiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTUgNS41IDguNSAxMiAxNSAxOC41Ii8+PC9zdmc+"
    },
    "white": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/arrow-left-white.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTUgNS41IDguNSAxMiAxNSAxOC41Ii8+PC9zdmc+"
    }
  },
  "chevron-down": {
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/chevron-down-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNi41IDkuNSAxMiAxNWw1LjUtNS41Ii8+PC9zdmc+"
    },
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/chevron-down-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNi41IDkuNSAxMiAxNWw1LjUtNS41Ii8+PC9zdmc+"
    }
  },
  "chevron-up": {
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/chevron-up-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNi41IDE0LjUgMTIgOWw1LjUgNS41Ii8+PC9zdmc+"
    }
  },
  "settings": {
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/settings-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIzLjIiLz48cGF0aCBkPSJNMTIgMi42djMiLz48cGF0aCBkPSJNMTIgMTguNHYzIi8+PHBhdGggZD0iTTQuNiA3LjhsMi42IDEuNSIvPjxwYXRoIGQ9Ik0xNi44IDE0LjdsMi42IDEuNSIvPjxwYXRoIGQ9Ik00LjYgMTYuMmwyLjYtMS41Ii8+PHBhdGggZD0iTTE2LjggOS4zbDIuNi0xLjUiLz48L3N2Zz4="
    },
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/settings-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIzLjIiLz48cGF0aCBkPSJNMTIgMi42djMiLz48cGF0aCBkPSJNMTIgMTguNHYzIi8+PHBhdGggZD0iTTQuNiA3LjhsMi42IDEuNSIvPjxwYXRoIGQ9Ik0xNi44IDE0LjdsMi42IDEuNSIvPjxwYXRoIGQ9Ik00LjYgMTYuMmwyLjYtMS41Ii8+PHBhdGggZD0iTTE2LjggOS4zbDIuNi0xLjUiLz48L3N2Zz4="
    }
  },
  "logout": {
    "red": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/logout-red.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGNTNGM0YiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTQuNSA0LjVIMThhMS41IDEuNSAwIDAgMSAxLjUgMS41djEyYTEuNSAxLjUgMCAwIDEtMS41IDEuNWgtMy41Ii8+PHBhdGggZD0iTTEwIDguMiA2LjIgMTIgMTAgMTUuOCIvPjxwYXRoIGQ9Ik02LjIgMTJIMTUiLz48L3N2Zz4="
    },
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/logout-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTQuNSA0LjVIMThhMS41IDEuNSAwIDAgMSAxLjUgMS41djEyYTEuNSAxLjUgMCAwIDEtMS41IDEuNWgtMy41Ii8+PHBhdGggZD0iTTEwIDguMiA2LjIgMTIgMTAgMTUuOCIvPjxwYXRoIGQ9Ik02LjIgMTJIMTUiLz48L3N2Zz4="
    }
  },
  "download": {
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/download-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgMy44djEwLjYiLz48cGF0aCBkPSJNOCAxMC42IDEyIDE0LjZsNC00Ii8+PHBhdGggZD0iTTQuNSAxOC41aDE1Ii8+PC9zdmc+"
    },
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/download-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgMy44djEwLjYiLz48cGF0aCBkPSJNOCAxMC42IDEyIDE0LjZsNC00Ii8+PHBhdGggZD0iTTQuNSAxOC41aDE1Ii8+PC9zdmc+"
    },
    "white": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/download-white.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgMy44djEwLjYiLz48cGF0aCBkPSJNOCAxMC42IDEyIDE0LjZsNC00Ii8+PHBhdGggZD0iTTQuNSAxOC41aDE1Ii8+PC9zdmc+"
    }
  },
  "lock": {
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/lock-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSI1IiB5PSIxMC41IiB3aWR0aD0iMTQiIGhlaWdodD0iOS41IiByeD0iMiIvPjxwYXRoIGQ9Ik04LjQgMTAuNVY3LjhhMy42IDMuNiAwIDAgMSA3LjIgMHYyLjciLz48L3N2Zz4="
    },
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/lock-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSI1IiB5PSIxMC41IiB3aWR0aD0iMTQiIGhlaWdodD0iOS41IiByeD0iMiIvPjxwYXRoIGQ9Ik04LjQgMTAuNVY3LjhhMy42IDMuNiAwIDAgMSA3LjIgMHYyLjciLz48L3N2Zz4="
    }
  },
  "refresh": {
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/refresh-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTkuNSAxMmE3LjUgNy41IDAgMSAxLTIuNi01LjciLz48cGF0aCBkPSJNMTkuOCA0LjV2NC4yaC00LjIiLz48L3N2Zz4="
    },
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/refresh-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTkuNSAxMmE3LjUgNy41IDAgMSAxLTIuNi01LjciLz48cGF0aCBkPSJNMTkuOCA0LjV2NC4yaC00LjIiLz48L3N2Zz4="
    }
  },
  "more": {
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/more-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjUuNSIgcj0iMS40Ii8+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMS40Ii8+PGNpcmNsZSBjeD0iMTIiIGN5PSIxOC41IiByPSIxLjQiLz48L3N2Zz4="
    }
  },
  "copy": {
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/copy-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSI4LjUiIHk9IjguNSIgd2lkdGg9IjExIiBoZWlnaHQ9IjExIiByeD0iMiIvPjxwYXRoIGQ9Ik0xNS41IDUuNUg2LjVhMiAyIDAgMCAwLTIgMnY5Ii8+PC9zdmc+"
    },
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/copy-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSI4LjUiIHk9IjguNSIgd2lkdGg9IjExIiBoZWlnaHQ9IjExIiByeD0iMiIvPjxwYXRoIGQ9Ik0xNS41IDUuNUg2LjVhMiAyIDAgMCAwLTIgMnY5Ii8+PC9zdmc+"
    }
  },
  "grid": {
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/grid-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSIzLjUiIHk9IjMuNSIgd2lkdGg9IjciIGhlaWdodD0iNyIgcng9IjEuNiIvPjxyZWN0IHg9IjEzLjUiIHk9IjMuNSIgd2lkdGg9IjciIGhlaWdodD0iNyIgcng9IjEuNiIvPjxyZWN0IHg9IjMuNSIgeT0iMTMuNSIgd2lkdGg9IjciIGhlaWdodD0iNyIgcng9IjEuNiIvPjxyZWN0IHg9IjEzLjUiIHk9IjEzLjUiIHdpZHRoPSI3IiBoZWlnaHQ9IjciIHJ4PSIxLjYiLz48L3N2Zz4="
    },
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/grid-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSIzLjUiIHk9IjMuNSIgd2lkdGg9IjciIGhlaWdodD0iNyIgcng9IjEuNiIvPjxyZWN0IHg9IjEzLjUiIHk9IjMuNSIgd2lkdGg9IjciIGhlaWdodD0iNyIgcng9IjEuNiIvPjxyZWN0IHg9IjMuNSIgeT0iMTMuNSIgd2lkdGg9IjciIGhlaWdodD0iNyIgcng9IjEuNiIvPjxyZWN0IHg9IjEzLjUiIHk9IjEzLjUiIHdpZHRoPSI3IiBoZWlnaHQ9IjciIHJ4PSIxLjYiLz48L3N2Zz4="
    }
  },
  "tag": {
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/tag-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTEuMiAzLjhINS41YTEuNyAxLjcgMCAwIDAtMS43IDEuN3Y1LjdjMCAuNDUuMTguODguNSAxLjJsNy44IDcuOGExLjcgMS43IDAgMCAwIDIuNCAwbDUuNy01LjdhMS43IDEuNyAwIDAgMCAwLTIuNGwtNy44LTcuOGExLjcgMS43IDAgMCAwLTEuMi0uNXoiLz48Y2lyY2xlIGN4PSI4LjQiIGN5PSI4LjQiIHI9IjEuNCIvPjwvc3ZnPg=="
    },
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/tag-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTEuMiAzLjhINS41YTEuNyAxLjcgMCAwIDAtMS43IDEuN3Y1LjdjMCAuNDUuMTguODguNSAxLjJsNy44IDcuOGExLjcgMS43IDAgMCAwIDIuNCAwbDUuNy01LjdhMS43IDEuNyAwIDAgMCAwLTIuNGwtNy44LTcuOGExLjcgMS43IDAgMCAwLTEuMi0uNXoiLz48Y2lyY2xlIGN4PSI4LjQiIGN5PSI4LjQiIHI9IjEuNCIvPjwvc3ZnPg=="
    }
  },
  "crown": {
    "orange": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/crown-orange.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGRjdEMDAiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMy41IDguNSA3IDEybDUtNi41IDUgNi41IDMuNS0zLjUiLz48cGF0aCBkPSJNNSAxMi41IDYuNSAxOWgxMWwxLjUtNi41Ii8+PC9zdmc+"
    }
  },
  "search": {
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/search-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMSIgY3k9IjExIiByPSI2LjUiLz48cGF0aCBkPSJNMTUuOCAxNS44IDIwLjUgMjAuNSIvPjwvc3ZnPg=="
    }
  },
  "close": {
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/close-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNiA2bDEyIDEyIi8+PHBhdGggZD0iTTE4IDYgNiAxOCIvPjwvc3ZnPg=="
    }
  },
  "share": {
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/share-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgMTQuNVY0Ii8+PHBhdGggZD0iTTguNSA3IDEyIDMuNSAxNS41IDciLz48cGF0aCBkPSJNNSAxMS41VjE5YTEuNSAxLjUgMCAwIDAgMS41IDEuNWgxMUExLjUgMS41IDAgMCAwIDE5IDE5di03LjUiLz48L3N2Zz4="
    },
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/share-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgMTQuNVY0Ii8+PHBhdGggZD0iTTguNSA3IDEyIDMuNSAxNS41IDciLz48cGF0aCBkPSJNNSAxMS41VjE5YTEuNSAxLjUgMCAwIDAgMS41IDEuNWgxMUExLjUgMS41IDAgMCAwIDE5IDE5di03LjUiLz48L3N2Zz4="
    },
    "white": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/share-white.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgMTQuNVY0Ii8+PHBhdGggZD0iTTguNSA3IDEyIDMuNSAxNS41IDciLz48cGF0aCBkPSJNNSAxMS41VjE5YTEuNSAxLjUgMCAwIDAgMS41IDEuNWgxMUExLjUgMS41IDAgMCAwIDE5IDE5di03LjUiLz48L3N2Zz4="
    }
  },
  "mic": {
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/mic-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSI5IiB5PSIyLjgiIHdpZHRoPSI2IiBoZWlnaHQ9IjExLjQiIHJ4PSIzIi8+PHBhdGggZD0iTTUuNSAxMWE2LjUgNi41IDAgMCAwIDEzIDAiLz48cGF0aCBkPSJNMTIgMTcuNXYzLjciLz48L3N2Zz4="
    },
    "white": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/mic-white.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSI5IiB5PSIyLjgiIHdpZHRoPSI2IiBoZWlnaHQ9IjExLjQiIHJ4PSIzIi8+PHBhdGggZD0iTTUuNSAxMWE2LjUgNi41IDAgMCAwIDEzIDAiLz48cGF0aCBkPSJNMTIgMTcuNXYzLjciLz48L3N2Zz4="
    }
  },
  "play": {
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/play-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNOCA1LjJ2MTMuNkwxOSAxMnoiLz48L3N2Zz4="
    },
    "white": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/play-white.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNOCA1LjJ2MTMuNkwxOSAxMnoiLz48L3N2Zz4="
    }
  },
  "pause": {
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/pause-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNOSA1djE0Ii8+PHBhdGggZD0iTTE1IDV2MTQiLz48L3N2Zz4="
    },
    "white": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/pause-white.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNOSA1djE0Ii8+PHBhdGggZD0iTTE1IDV2MTQiLz48L3N2Zz4="
    }
  },
  "photo": {
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/photo-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSIzLjUiIHk9IjQuNSIgd2lkdGg9IjE3IiBoZWlnaHQ9IjE1IiByeD0iMiIvPjxjaXJjbGUgY3g9IjguNiIgY3k9IjkuMyIgcj0iMS42Ii8+PHBhdGggZD0iTTMuNSAxNi41IDkgMTEuNWw0LjUgNCAzLTIuNSA0IDMuNSIvPjwvc3ZnPg=="
    }
  },
  "photo-plus": {
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/photo-plus-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNDOUNERDQiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSIzLjUiIHk9IjciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxMy41IiByeD0iMiIvPjxjaXJjbGUgY3g9IjcuOCIgY3k9IjExLjIiIHI9IjEuNCIvPjxwYXRoIGQ9Ik0zLjUgMTcuNSA4IDEzLjVsMy40IDMgMi42LTIgMy41IDMiLz48cGF0aCBkPSJNMTggMi44djYiLz48cGF0aCBkPSJNMTUgNS44aDYiLz48L3N2Zz4="
    }
  },
  "scan": {
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/scan-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNCA4VjUuNUExLjUgMS41IDAgMCAxIDUuNSA0SDgiLz48cGF0aCBkPSJNMTYgNGgyLjVBMS41IDEuNSAwIDAgMSAyMCA1LjVWOCIvPjxwYXRoIGQ9Ik0yMCAxNnYyLjVhMS41IDEuNSAwIDAgMS0xLjUgMS41SDE2Ii8+PHBhdGggZD0iTTggMjBINS41QTEuNSAxLjUgMCAwIDEgNCAxOC41VjE2Ii8+PHBhdGggZD0iTTMuNSAxMmgxNyIvPjwvc3ZnPg=="
    },
    "white": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/scan-white.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNCA4VjUuNUExLjUgMS41IDAgMCAxIDUuNSA0SDgiLz48cGF0aCBkPSJNMTYgNGgyLjVBMS41IDEuNSAwIDAgMSAyMCA1LjVWOCIvPjxwYXRoIGQ9Ik0yMCAxNnYyLjVhMS41IDEuNSAwIDAgMS0xLjUgMS41SDE2Ii8+PHBhdGggZD0iTTggMjBINS41QTEuNSAxLjUgMCAwIDEgNCAxOC41VjE2Ii8+PHBhdGggZD0iTTMuNSAxMmgxNyIvPjwvc3ZnPg=="
    }
  },
  "trash": {
    "red": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/trash-red.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGNTNGM0YiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNCA3aDE2Ii8+PHBhdGggZD0iTTkgN1Y0aDZ2MyIvPjxwYXRoIGQ9Ik02LjUgNyA3LjQgMTlhMS41IDEuNSAwIDAgMCAxLjUgMS40aDYuMmExLjUgMS41IDAgMCAwIDEuNS0xLjRMMTcuNSA3Ii8+PC9zdmc+"
    }
  },
  "edit": {
    "gray": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/edit-gray.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4NjkwOUMiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTQuNSA1LjUgMTguNSA5LjUiLz48cGF0aCBkPSJNNSAxOXYtNEwxNS44IDQuMmEyLjEgMi4xIDAgMCAxIDMgM0w4IDE4eiIvPjwvc3ZnPg=="
    },
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/edit-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTQuNSA1LjUgMTguNSA5LjUiLz48cGF0aCBkPSJNNSAxOXYtNEwxNS44IDQuMmEyLjEgMi4xIDAgMCAxIDMgM0w4IDE4eiIvPjwvc3ZnPg=="
    }
  },
  "warn": {
    "orange": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/warn-orange.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGRjdEMDAiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgNCAyMSAxOS41SDN6Ii8+PHBhdGggZD0iTTEyIDEwdjQiLz48cGF0aCBkPSJNMTIgMTYuOHYuMiIvPjwvc3ZnPg=="
    },
    "red": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/warn-red.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGNTNGM0YiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgNCAyMSAxOS41SDN6Ii8+PHBhdGggZD0iTTEyIDEwdjQiLz48cGF0aCBkPSJNMTIgMTYuOHYuMiIvPjwvc3ZnPg=="
    }
  },
  "swap": {
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/swap-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNyA4LjVoMTMiLz48cGF0aCBkPSJNMTcgNS41bDMgMy0zIDMiLz48cGF0aCBkPSJNMTcgMTUuNUg0Ii8+PHBhdGggZD0iTTcgMTIuNWwtMyAzIDMgMyIvPjwvc3ZnPg=="
    }
  },
  "clock": {
    "orange": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/clock-orange.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGRjdEMDAiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI4LjUiLz48cGF0aCBkPSJNMTIgNy41VjEybDMuMiAyIi8+PC9zdmc+"
    }
  },
  "empty-box": {
    "line": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/empty-box-line.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNEREUxRTgiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNCAxMCAxMiA2bDggNC04IDR6Ii8+PHBhdGggZD0iTTQgMTB2N2w4IDQgOC00di03Ii8+PHBhdGggZD0iTTEyIDE0djciLz48L3N2Zz4="
    }
  },
  "cloud-off": {
    "line": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/cloud-off-line.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNEREUxRTgiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNy41IDE4aDkuM2EzLjcgMy43IDAgMCAwIC42LTcuMzVBNS41IDUuNSAwIDAgMCA2LjcgOC45Ii8+PHBhdGggZD0iTTQgNGwxNiAxNiIvPjwvc3ZnPg=="
    }
  },
  "search-empty": {
    "line": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/search-empty-line.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNEREUxRTgiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMSIgY3k9IjExIiByPSI3Ii8+PHBhdGggZD0iTTE2LjIgMTYuMiAyMSAyMSIvPjxwYXRoIGQ9Ik05IDlsNCA0Ii8+PHBhdGggZD0iTTEzIDlsLTQgNCIvPjwvc3ZnPg=="
    }
  },
  "logo": {
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/logo-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCIgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMi42IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxyZWN0IHg9IjUiIHk9IjkiIHdpZHRoPSIzOCIgaGVpZ2h0PSIzMCIgcng9IjUiLz48cGF0aCBkPSJNNSAxOWgzOCIvPjxwYXRoIGQ9Ik0xNSA1djgiLz48cGF0aCBkPSJNMzMgNXY4Ii8+PHBhdGggZD0iTTE2IDI5bDYgNiAxMC0xMSIvPjwvc3ZnPg=="
    }
  },
  "info": {
    "brand": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/info-brand.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMzMzcwRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI4LjUiLz48cGF0aCBkPSJNMTIgMTF2NSIvPjxwYXRoIGQ9Ik0xMiA3Ljh2LjIiLz48L3N2Zz4="
    },
    "red": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/info-red.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGNTNGM0YiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI4LjUiLz48cGF0aCBkPSJNMTIgMTF2NSIvPjxwYXRoIGQ9Ik0xMiA3Ljh2LjIiLz48L3N2Zz4="
    },
    "orange": {
      "cloud": "cloud://YOUR_ENV_ID.636c-YOUR_ENV_ID-YOUR_UIN/icons/info-orange.svg",
      "data": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSJub25lIiBzdHJva2U9IiNGRjdEMDAiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI4LjUiLz48cGF0aCBkPSJNMTIgMTF2NSIvPjxwYXRoIGQ9Ik0xMiA3Ljh2LjIiLz48L3N2Zz4="
    }
  }
};

function get(name, variant) {
  const item = ICONS[name];
  if (!item) return null;
  const v = variant && item[variant] ? variant : Object.keys(item)[0];
  return item[v];
}

module.exports = { ICONS, get };
