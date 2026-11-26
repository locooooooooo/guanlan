//! 原生文件夹选择对话框。
//!
//! - Windows：直接调用 Vista+ COM `IFileOpenDialog`（`FOS_PICKFOLDERS`），零新增 crate 依赖、
//!   不闪黑框、并以当前窗口 `HWND` 作为模态父窗口；
//! - 非 Windows：回退常见桌面工具（zenity/kdialog），若不可用返回明确提示。

#[cfg(windows)]
mod win_picker {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    const CLSID_FILE_OPEN_DIALOG: Guid = Guid {
        data1: 0xDC1C_5A9C,
        data2: 0xE88A,
        data3: 0x4DDE,
        data4: [0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7],
    };

    const IID_I_FILE_OPEN_DIALOG: Guid = Guid {
        data1: 0xD57C_7288,
        data2: 0xD4AD,
        data3: 0x4768,
        data4: [0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60],
    };

    const COINIT_APARTMENTTHREADED: u32 = 0x2;
    const CLSCTX_INPROC_SERVER: u32 = 0x1;
    const FOS_PICKFOLDERS: u32 = 0x0000_0020;
    const FOS_FORCEFILESYSTEM: u32 = 0x0000_0040;
    const FOS_ALLOWMULTISELECT: u32 = 0x0000_0200;
    const FOS_PATHMUSTEXIST: u32 = 0x0000_0800;
    const FOS_FILEMUSTEXIST: u32 = 0x0000_1000;
    const SIGDN_FILESYSPATH: u32 = 0x8005_8000;
    const RPC_E_CHANGED_MODE: i32 = 0x8001_0106_u32 as i32;
    const HRESULT_ERROR_CANCELLED: i32 = 0x8007_04C7_u32 as i32;

    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(pv_reserved: *const c_void, dw_co_init: u32) -> i32;
        fn CoUninitialize();
        fn CoCreateInstance(
            rclsid: *const Guid,
            p_unk_outer: *mut c_void,
            dw_cls_context: u32,
            riid: *const Guid,
            ppv: *mut *mut c_void,
        ) -> i32;
        fn CoTaskMemFree(pv: *mut c_void);
    }

    #[repr(C)]
    struct ComObject {
        vtbl: *const *const c_void,
    }

    struct ComGuard<T: FnMut()> {
        cleanup: Option<T>,
    }

    impl<T: FnMut()> ComGuard<T> {
        fn new(cleanup: T) -> Self {
            Self {
                cleanup: Some(cleanup),
            }
        }
    }

    impl<T: FnMut()> Drop for ComGuard<T> {
        fn drop(&mut self) {
            if let Some(mut f) = self.cleanup.take() {
                f();
            }
        }
    }

    unsafe fn release_com(obj: *mut ComObject) {
        if !obj.is_null() {
            let release: unsafe extern "system" fn(*mut ComObject) -> u32 =
                std::mem::transmute(*(*obj).vtbl.add(2));
            release(obj);
        }
    }

    pub fn pick_folder(owner_hwnd: isize, title: &str) -> Result<Option<String>, String> {
        // SAFETY: 所有指针均经空指针与 HRESULT 检查，且通过 ComGuard 确保 COM 对象与线程单元释放。
        unsafe {
            let hr_init = CoInitializeEx(null(), COINIT_APARTMENTTHREADED);
            let need_uninit = if hr_init == 0 || hr_init == 1 {
                true
            } else if hr_init == RPC_E_CHANGED_MODE {
                false
            } else {
                return Err(format!("COM 初始化失败: 0x{hr_init:08x}"));
            };
            let _com_uninit = ComGuard::new(|| {
                if need_uninit {
                    CoUninitialize();
                }
            });

            let mut raw_dialog: *mut c_void = null_mut();
            let hr_create = CoCreateInstance(
                &CLSID_FILE_OPEN_DIALOG,
                null_mut(),
                CLSCTX_INPROC_SERVER,
                &IID_I_FILE_OPEN_DIALOG,
                &mut raw_dialog,
            );
            if hr_create < 0 || raw_dialog.is_null() {
                return Err(format!("创建系统文件夹选择器失败: 0x{hr_create:08x}"));
            }
            let dialog = raw_dialog as *mut ComObject;
            let _release_dialog = ComGuard::new(|| release_com(dialog));

            let get_options: unsafe extern "system" fn(*mut ComObject, *mut u32) -> i32 =
                std::mem::transmute(*(*dialog).vtbl.add(10));
            let set_options: unsafe extern "system" fn(*mut ComObject, u32) -> i32 =
                std::mem::transmute(*(*dialog).vtbl.add(9));
            let set_title: unsafe extern "system" fn(*mut ComObject, *const u16) -> i32 =
                std::mem::transmute(*(*dialog).vtbl.add(17));
            let show: unsafe extern "system" fn(*mut ComObject, *mut c_void) -> i32 =
                std::mem::transmute(*(*dialog).vtbl.add(3));
            let get_result: unsafe extern "system" fn(*mut ComObject, *mut *mut c_void) -> i32 =
                std::mem::transmute(*(*dialog).vtbl.add(20));

            let mut options: u32 = 0;
            let hr_get_opt = get_options(dialog, &mut options);
            if hr_get_opt < 0 {
                return Err(format!("读取对话框选项失败: 0x{hr_get_opt:08x}"));
            }
            let hr_set_opt = set_options(
                dialog,
                options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST,
            );
            if hr_set_opt < 0 {
                return Err(format!("设置文件夹选择选项失败: 0x{hr_set_opt:08x}"));
            }

            let mut wide_title: Vec<u16> = title.encode_utf16().collect();
            wide_title.push(0);
            let _ = set_title(dialog, wide_title.as_ptr());

            let hr_show = show(dialog, owner_hwnd as *mut c_void);
            if hr_show == HRESULT_ERROR_CANCELLED {
                return Ok(None);
            }
            if hr_show < 0 {
                return Err(format!("显示文件夹对话框失败: 0x{hr_show:08x}"));
            }

            let mut raw_item: *mut c_void = null_mut();
            let hr_res = get_result(dialog, &mut raw_item);
            if hr_res < 0 || raw_item.is_null() {
                return Err(format!("获取所选文件夹失败: 0x{hr_res:08x}"));
            }
            let item = raw_item as *mut ComObject;
            let _release_item = ComGuard::new(|| release_com(item));

            let get_display_name: unsafe extern "system" fn(
                *mut ComObject,
                u32,
                *mut *mut u16,
            ) -> i32 = std::mem::transmute(*(*item).vtbl.add(5));
            let mut psz_path: *mut u16 = null_mut();
            let hr_name = get_display_name(item, SIGDN_FILESYSPATH, &mut psz_path);
            if hr_name < 0 || psz_path.is_null() {
                return Err(format!("读取文件夹路径失败: 0x{hr_name:08x}"));
            }
            let _free_path = ComGuard::new(|| CoTaskMemFree(psz_path as *mut c_void));

            let mut len = 0usize;
            while *psz_path.add(len) != 0 {
                len += 1;
            }
            let slice = std::slice::from_raw_parts(psz_path, len);
            Ok(Some(String::from_utf16_lossy(slice)))
        }
    }

    pub fn pick_files(owner_hwnd: isize, title: &str) -> Result<Vec<String>, String> {
        // SAFETY: 所有 COM 指针、数组计数与 CoTaskMem 字符串均经空指针与 HRESULT 校验并由 ComGuard 释放。
        unsafe {
            let hr_init = CoInitializeEx(null(), COINIT_APARTMENTTHREADED);
            let need_uninit = if hr_init == 0 || hr_init == 1 {
                true
            } else if hr_init == RPC_E_CHANGED_MODE {
                false
            } else {
                return Err(format!("COM 初始化失败: 0x{hr_init:08x}"));
            };
            let _com_uninit = ComGuard::new(|| {
                if need_uninit {
                    CoUninitialize();
                }
            });

            let mut raw_dialog: *mut c_void = null_mut();
            let hr_create = CoCreateInstance(
                &CLSID_FILE_OPEN_DIALOG,
                null_mut(),
                CLSCTX_INPROC_SERVER,
                &IID_I_FILE_OPEN_DIALOG,
                &mut raw_dialog,
            );
            if hr_create < 0 || raw_dialog.is_null() {
                return Err(format!("创建系统文件选择器失败: 0x{hr_create:08x}"));
            }
            let dialog = raw_dialog as *mut ComObject;
            let _release_dialog = ComGuard::new(|| release_com(dialog));

            let get_options: unsafe extern "system" fn(*mut ComObject, *mut u32) -> i32 =
                std::mem::transmute(*(*dialog).vtbl.add(10));
            let set_options: unsafe extern "system" fn(*mut ComObject, u32) -> i32 =
                std::mem::transmute(*(*dialog).vtbl.add(9));
            let set_title: unsafe extern "system" fn(*mut ComObject, *const u16) -> i32 =
                std::mem::transmute(*(*dialog).vtbl.add(17));
            let show: unsafe extern "system" fn(*mut ComObject, *mut c_void) -> i32 =
                std::mem::transmute(*(*dialog).vtbl.add(3));
            let get_results: unsafe extern "system" fn(*mut ComObject, *mut *mut c_void) -> i32 =
                std::mem::transmute(*(*dialog).vtbl.add(27));

            let mut options: u32 = 0;
            let hr_get_opt = get_options(dialog, &mut options);
            if hr_get_opt < 0 {
                return Err(format!("读取对话框选项失败: 0x{hr_get_opt:08x}"));
            }
            let hr_set_opt = set_options(
                dialog,
                options | FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST | FOS_ALLOWMULTISELECT,
            );
            if hr_set_opt < 0 {
                return Err(format!("设置多文件选择选项失败: 0x{hr_set_opt:08x}"));
            }

            let mut wide_title: Vec<u16> = title.encode_utf16().collect();
            wide_title.push(0);
            let _ = set_title(dialog, wide_title.as_ptr());

            let hr_show = show(dialog, owner_hwnd as *mut c_void);
            if hr_show == HRESULT_ERROR_CANCELLED {
                return Ok(Vec::new());
            }
            if hr_show < 0 {
                return Err(format!("显示文件选择对话框失败: 0x{hr_show:08x}"));
            }

            let mut raw_array: *mut c_void = null_mut();
            let hr_res = get_results(dialog, &mut raw_array);
            if hr_res < 0 || raw_array.is_null() {
                return Err(format!("获取所选文件列表失败: 0x{hr_res:08x}"));
            }
            let array = raw_array as *mut ComObject;
            let _release_array = ComGuard::new(|| release_com(array));

            let get_count: unsafe extern "system" fn(*mut ComObject, *mut u32) -> i32 =
                std::mem::transmute(*(*array).vtbl.add(7));
            let get_item_at: unsafe extern "system" fn(
                *mut ComObject,
                u32,
                *mut *mut c_void,
            ) -> i32 = std::mem::transmute(*(*array).vtbl.add(8));

            let mut count: u32 = 0;
            let hr_cnt = get_count(array, &mut count);
            if hr_cnt < 0 {
                return Err(format!("读取文件计数失败: 0x{hr_cnt:08x}"));
            }

            let mut out = Vec::with_capacity(count as usize);
            for idx in 0..count {
                let mut raw_item: *mut c_void = null_mut();
                let hr_item = get_item_at(array, idx, &mut raw_item);
                if hr_item < 0 || raw_item.is_null() {
                    continue;
                }
                let item = raw_item as *mut ComObject;
                let _release_item = ComGuard::new(|| release_com(item));

                let get_display_name: unsafe extern "system" fn(
                    *mut ComObject,
                    u32,
                    *mut *mut u16,
                ) -> i32 = std::mem::transmute(*(*item).vtbl.add(5));
                let mut psz_path: *mut u16 = null_mut();
                let hr_name = get_display_name(item, SIGDN_FILESYSPATH, &mut psz_path);
                if hr_name < 0 || psz_path.is_null() {
                    continue;
                }
                let _free_path = ComGuard::new(|| CoTaskMemFree(psz_path as *mut c_void));

                let mut len = 0usize;
                while *psz_path.add(len) != 0 {
                    len += 1;
                }
                let slice = std::slice::from_raw_parts(psz_path, len);
                out.push(String::from_utf16_lossy(slice));
            }
            Ok(out)
        }
    }
}

#[cfg(not(windows))]
mod unix_picker {
    use std::process::Command;

    pub fn pick_folder(_owner_hwnd: isize, title: &str) -> Result<Option<String>, String> {
        if let Ok(out) = Command::new("zenity")
            .args(["--file-selection", "--directory", "--title", title])
            .output()
        {
            if out.status.success() {
                let path = String::from_utf8_lossy(&out.stdout).trim().to_owned();
                return Ok((!path.is_empty()).then_some(path));
            }
            if out.status.code() == Some(1) {
                return Ok(None);
            }
        }
        Err("当前环境未检测到原生文件夹对话框，请直接粘贴目录路径".to_owned())
    }

    pub fn pick_files(_owner_hwnd: isize, title: &str) -> Result<Vec<String>, String> {
        if let Ok(out) = Command::new("zenity")
            .args([
                "--file-selection",
                "--multiple",
                "--separator=\n",
                "--title",
                title,
            ])
            .output()
        {
            if out.status.success() {
                let paths = String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect();
                return Ok(paths);
            }
            if out.status.code() == Some(1) {
                return Ok(Vec::new());
            }
        }
        Err("当前环境未检测到原生文件对话框，请直接拖入文件到工作区".to_owned())
    }
}

pub async fn pick_workspace_folder_async(owner_hwnd: isize) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(windows)]
        {
            win_picker::pick_folder(owner_hwnd, "选择观澜工作区文件夹")
        }
        #[cfg(not(windows))]
        {
            unix_picker::pick_folder(owner_hwnd, "选择观澜工作区文件夹")
        }
    })
    .await
    .map_err(|e| format!("文件夹选择器线程异常: {e}"))?
}

pub async fn pick_external_files_async(owner_hwnd: isize) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        #[cfg(windows)]
        {
            win_picker::pick_files(owner_hwnd, "选择要导入工作区的文件")
        }
        #[cfg(not(windows))]
        {
            unix_picker::pick_files(owner_hwnd, "选择要导入工作区的文件")
        }
    })
    .await
    .map_err(|e| format!("文件选择器线程异常: {e}"))?
}
