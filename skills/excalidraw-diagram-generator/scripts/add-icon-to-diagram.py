#!/usr/bin/env python3
"""
Add icons from Excalidraw libraries to diagrams.

This script reads an icon JSON file from an Excalidraw library, transforms its coordinates
to a target position, generates unique IDs, and adds it to an existing Excalidraw diagram.
Works with any Excalidraw library (AWS, GCP, Azure, Kubernetes, etc.).

Usage:
    python add-icon-to-diagram.py <diagram_path> <icon_name> <x> <y> [OPTIONS]

Options:
    --library-path PATH    Path to the icon library directory (default: aws-architecture-icons)
    --label TEXT           Add a text label below the icon
    --use-edit-suffix      Edit via .excalidraw.edit to avoid editor overwrite issues (enabled by default; use --no-use-edit-suffix to disable)

Examples:
    python add-icon-to-diagram.py diagram.excalidraw EC2 500 300
    python add-icon-to-diagram.py diagram.excalidraw EC2 500 300 --label "Web Server"
    python add-icon-to-diagram.py diagram.excalidraw VPC 200 150 --library-path libraries/gcp-icons
    python add-icon-to-diagram.py diagram.excalidraw EC2 500 300 --use-edit-suffix
"""

from contextlib import contextmanager
import copy
import json
import os
import stat
import sys
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Dict, List, Any, Tuple


_DACL_SECURITY_INFORMATION = 0x00000004
_SE_DACL_PROTECTED = 0x1000
_GENERIC_WRITE = 0x40000000
_WRITE_DAC = 0x00040000
_CREATE_NEW = 1
_FILE_ATTRIBUTE_NORMAL = 0x00000080
_ERROR_FILE_EXISTS = 80

_THREAD_LOCKS: Dict[str, threading.Lock] = {}
_THREAD_LOCKS_GUARD = threading.Lock()


def _is_windows() -> bool:
    return os.name == "nt"


def _get_thread_lock(key: str) -> threading.Lock:
    with _THREAD_LOCKS_GUARD:
        lock = _THREAD_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _THREAD_LOCKS[key] = lock
        return lock


@contextmanager
def diagram_edit_lock(diagram_path: Path):
    """Serialize prepare, promotion, and cleanup for a target diagram across processes."""
    resolved = diagram_path.resolve()
    if not resolved.parent.exists():
        yield
        return
    lock_path = resolved.with_name(f".{resolved.name}.lock")
    thread_lock = _get_thread_lock(os.path.normcase(str(lock_path)))
    with thread_lock:
        if os.name == "nt":
            import msvcrt

            fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o666)
            locked = False
            try:
                while True:
                    try:
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
                        locked = True
                        break
                    except OSError:
                        continue
                yield
            finally:
                try:
                    if locked:
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                finally:
                    os.close(fd)
                    try:
                        os.unlink(lock_path)
                    except OSError:
                        pass
        else:
            import fcntl

            fd = -1
            while True:
                fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o666)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX)
                    try:
                        st_path = os.stat(lock_path)
                    except FileNotFoundError:
                        os.close(fd)
                        continue
                    if os.path.samestat(os.fstat(fd), st_path):
                        break
                    os.close(fd)
                except BaseException:
                    os.close(fd)
                    raise
            try:
                yield
            finally:
                try:
                    st_cur = os.stat(lock_path)
                    if os.path.samestat(os.fstat(fd), st_cur):
                        os.unlink(lock_path)
                except OSError:
                    pass
                finally:
                    try:
                        fcntl.flock(fd, fcntl.LOCK_UN)
                    finally:
                        os.close(fd)


def _same_file_identity(st1: os.stat_result, st2: os.stat_result) -> bool:
    if st1.st_ino and st2.st_ino:
        return os.path.samestat(st1, st2)
    return st1.st_mtime_ns == st2.st_mtime_ns and st1.st_size == st2.st_size


def generate_unique_id() -> str:
    """Generate a unique ID for Excalidraw elements."""
    return str(uuid.uuid4()).replace('-', '')[:16]


def calculate_bounding_box(elements: List[Dict[str, Any]]) -> Tuple[float, float, float, float]:
    """Calculate the bounding box (min_x, min_y, max_x, max_y) of icon elements."""
    if not elements:
        return (0, 0, 0, 0)
    
    min_x = float('inf')
    min_y = float('inf')
    max_x = float('-inf')
    max_y = float('-inf')
    
    for element in elements:
        if 'x' in element and 'y' in element:
            x = element['x']
            y = element['y']
            width = element.get('width', 0)
            height = element.get('height', 0)
            
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x + width)
            max_y = max(max_y, y + height)
    
    if min_x == float('inf'):
        return (0, 0, 0, 0)

    return (min_x, min_y, max_x, max_y)


def transform_icon_elements(
    elements: List[Dict[str, Any]], 
    target_x: float, 
    target_y: float
) -> List[Dict[str, Any]]:
    """
    Transform icon elements to target coordinates with unique IDs.
    
    Args:
        elements: Icon elements from JSON file
        target_x: Target X coordinate (top-left position)
        target_y: Target Y coordinate (top-left position)
    
    Returns:
        Transformed elements with new coordinates and IDs
    """
    if not elements:
        return []
    
    # Calculate bounding box
    min_x, min_y, max_x, max_y = calculate_bounding_box(elements)
    
    # Calculate offset
    offset_x = target_x - min_x
    offset_y = target_y - min_y
    
    # Create ID mapping: old_id -> new_id
    id_mapping = {}
    for element in elements:
        if 'id' in element:
            old_id = element['id']
            id_mapping[old_id] = generate_unique_id()
    
    # Create group ID mapping
    group_id_mapping = {}
    for element in elements:
        if 'groupIds' in element:
            for old_group_id in element['groupIds']:
                if old_group_id not in group_id_mapping:
                    group_id_mapping[old_group_id] = generate_unique_id()
    
    # Transform elements
    transformed = []
    for element in elements:
        new_element = copy.deepcopy(element)
        
        # Update coordinates
        if 'x' in new_element:
            new_element['x'] = new_element['x'] + offset_x
        if 'y' in new_element:
            new_element['y'] = new_element['y'] + offset_y
        
        # Update ID
        if 'id' in new_element:
            new_element['id'] = id_mapping[new_element['id']]
        
        # Update group IDs
        if 'groupIds' in new_element:
            new_element['groupIds'] = [
                group_id_mapping[gid] for gid in new_element['groupIds']
            ]
        
        # Update binding references if they exist
        if 'startBinding' in new_element and new_element['startBinding']:
            if 'elementId' in new_element['startBinding']:
                old_id = new_element['startBinding']['elementId']
                if old_id in id_mapping:
                    new_element['startBinding']['elementId'] = id_mapping[old_id]
        
        if 'endBinding' in new_element and new_element['endBinding']:
            if 'elementId' in new_element['endBinding']:
                old_id = new_element['endBinding']['elementId']
                if old_id in id_mapping:
                    new_element['endBinding']['elementId'] = id_mapping[old_id]
        
        # Update containerId if it exists
        if 'containerId' in new_element and new_element['containerId']:
            old_id = new_element['containerId']
            if old_id in id_mapping:
                new_element['containerId'] = id_mapping[old_id]
        
        # Update boundElements if they exist
        if 'boundElements' in new_element and new_element['boundElements']:
            new_bound_elements = []
            for bound_elem in new_element['boundElements']:
                if isinstance(bound_elem, dict) and 'id' in bound_elem:
                    old_id = bound_elem['id']
                    if old_id in id_mapping:
                        bound_elem['id'] = id_mapping[old_id]
                new_bound_elements.append(bound_elem)
            new_element['boundElements'] = new_bound_elements
        
        transformed.append(new_element)
    
    return transformed


def load_icon(icon_name: str, library_path: Path) -> List[Dict[str, Any]]:
    """
    Load icon elements from library.
    
    Args:
        icon_name: Name of the icon (e.g., "EC2", "VPC")
        library_path: Path to the icon library directory
    
    Returns:
        List of icon elements
    """
    icon_file = library_path / "icons" / f"{icon_name}.json"
    
    if not icon_file.exists():
        raise FileNotFoundError(f"Icon file not found: {icon_file}")
    
    with open(icon_file, 'r', encoding='utf-8') as f:
        icon_data = json.load(f)
    
    return icon_data.get('elements', [])


def prepare_edit_path(diagram_path: Path, use_edit_suffix: bool) -> tuple[Path, Path | None]:
    """
    Prepare a safe edit path to avoid editor overwrite issues.

    Returns:
        (work_path, final_path)
        - work_path: file path to read/write during edit
        - final_path: file path to rename back to (or None if not used)
    """
    resolved_path = diagram_path.resolve()

    if not use_edit_suffix:
        return resolved_path, None

    if resolved_path.suffix != ".excalidraw":
        return resolved_path, None

    edit_path = resolved_path.with_suffix(resolved_path.suffix + ".edit")

    if resolved_path.exists():
        if edit_path.exists():
            raise FileExistsError(f"Edit file already exists: {edit_path}")
        resolved_path.rename(edit_path)

    return edit_path, resolved_path


def finalize_edit_path(
    work_path: Path,
    final_path: Path | None,
    staged_path: Path | None = None,
) -> None:
    """Finalize edit by atomically promoting staged/work file to .excalidraw if needed."""
    if final_path is None:
        return

    backup_stat: os.stat_result | None = None
    if staged_path is not None and work_path != final_path:
        try:
            backup_stat = work_path.lstat()
        except OSError:
            backup_stat = None

    source_path = staged_path if staged_path is not None else work_path
    os.replace(source_path, final_path)

    if staged_path is not None and work_path != final_path and backup_stat is not None:
        try:
            current_stat = work_path.lstat()
        except FileNotFoundError:
            return
        except OSError as cleanup_err:
            print(
                f"Warning: Insertion committed to {final_path}, but could not inspect backup "
                f"{work_path}: {cleanup_err}. Confirm no edit is active, then move {work_path} "
                f"out of the way before continuing.",
                file=sys.stderr,
            )
            return

        if not _same_file_identity(backup_stat, current_stat):
            return

        try:
            work_path.unlink(missing_ok=True)
        except OSError as cleanup_err:
            print(
                f"Warning: Insertion committed to {final_path}, but could not remove backup "
                f"{work_path}: {cleanup_err}. Confirm no edit is active, then move {work_path} "
                f"out of the way before continuing.",
                file=sys.stderr,
            )


def restore_edit_path(work_path: Path, final_path: Path) -> None:
    """Restore original .edit file to final_path without replacing an existing file."""
    if not work_path.exists():
        return

    try:
        if _is_windows():
            os.rename(work_path, final_path)
        else:
            os.link(work_path, final_path)
    except FileExistsError:
        return
    except OSError as restore_err:
        print(
            f"Warning: Could not restore diagram {final_path} from backup {work_path}: "
            f"{restore_err}. Original diagram remains at {work_path}.",
            file=sys.stderr,
        )
        return

    if not _is_windows():
        try:
            work_path.unlink()
        except OSError as unlink_err:
            print(
                f"Warning: Restored {final_path}, but could not remove backup {work_path}: {unlink_err}",
                file=sys.stderr,
            )


def _get_windows_dacl_sd(source_path: Path):
    """Fetch a self-relative SECURITY_DESCRIPTOR containing source_path's DACL on Windows."""
    import ctypes
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi32.GetFileSecurityW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    ]
    advapi32.GetFileSecurityW.restype = wintypes.BOOL

    needed = wintypes.DWORD(0)
    advapi32.GetFileSecurityW(
        str(source_path),
        _DACL_SECURITY_INFORMATION,
        None,
        0,
        ctypes.byref(needed),
    )
    if needed.value == 0:
        raise ctypes.WinError(ctypes.get_last_error())

    sd_buf = ctypes.create_string_buffer(needed.value)
    if not advapi32.GetFileSecurityW(
        str(source_path),
        _DACL_SECURITY_INFORMATION,
        sd_buf,
        needed.value,
        ctypes.byref(needed),
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    return sd_buf


def _open_windows_temp_file(parent_dir: Path, prefix: str, source_sd):
    """Create a temporary text writer on Windows with source_sd applied before writing."""
    if source_sd is None:
        tmp_file = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=parent_dir,
            prefix=prefix,
            suffix=".tmp",
            delete=False,
        )
        return Path(tmp_file.name), tmp_file

    import ctypes
    from ctypes import wintypes
    import msvcrt

    class _SECURITY_ATTRIBUTES(ctypes.Structure):
        _fields_ = [
            ("nLength", wintypes.DWORD),
            ("lpSecurityDescriptor", wintypes.LPVOID),
            ("bInheritHandle", wintypes.BOOL),
        ]

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi32.SetSecurityDescriptorControl.argtypes = [
        wintypes.LPVOID,
        wintypes.WORD,
        wintypes.WORD,
    ]
    advapi32.SetSecurityDescriptorControl.restype = wintypes.BOOL
    advapi32.SetKernelObjectSecurity.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPVOID,
    ]
    advapi32.SetKernelObjectSecurity.restype = wintypes.BOOL

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(_SECURITY_ATTRIBUTES),
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    # Block parent-directory ACL inheritance at creation time so no account denied by
    # the original diagram ever gains inherited read access on the temp or staged file.
    protected_sd = ctypes.create_string_buffer(source_sd.raw, len(source_sd))
    if not advapi32.SetSecurityDescriptorControl(
        protected_sd, _SE_DACL_PROTECTED, _SE_DACL_PROTECTED
    ):
        raise ctypes.WinError(ctypes.get_last_error())

    sa = _SECURITY_ATTRIBUTES(
        nLength=ctypes.sizeof(_SECURITY_ATTRIBUTES),
        lpSecurityDescriptor=ctypes.cast(protected_sd, wintypes.LPVOID),
        bInheritHandle=False,
    )
    invalid_handle = wintypes.HANDLE(-1).value

    while True:
        candidate = parent_dir / f"{prefix}{uuid.uuid4().hex}.tmp"
        handle = kernel32.CreateFileW(
            str(candidate),
            _GENERIC_WRITE | _WRITE_DAC,
            0,
            ctypes.byref(sa),
            _CREATE_NEW,
            _FILE_ATTRIBUTE_NORMAL,
            None,
        )
        if handle is None or handle == invalid_handle:
            err = ctypes.get_last_error()
            if err == _ERROR_FILE_EXISTS:
                continue
            raise ctypes.WinError(err)

        handle_owned = True
        fd = -1
        try:
            if not advapi32.SetKernelObjectSecurity(
                handle, _DACL_SECURITY_INFORMATION, source_sd
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            fd = msvcrt.open_osfhandle(
                handle, os.O_WRONLY | getattr(os, "O_BINARY", 0)
            )
            handle_owned = False
            writer = os.fdopen(fd, "w", encoding="utf-8")
            fd = -1
            return candidate, writer
        except BaseException:
            if fd != -1:
                os.close(fd)
            elif handle_owned:
                kernel32.CloseHandle(handle)
            try:
                candidate.unlink(missing_ok=True)
            except OSError:
                pass
            raise


def write_diagram_atomic(
    diagram: Dict[str, Any],
    target_path: Path,
    metadata_source: Path | None = None,
) -> None:
    """Write diagram JSON to a temporary file and atomically replace target_path."""
    source_for_metadata = metadata_source if metadata_source is not None else target_path
    source_exists = source_for_metadata.exists()
    temp_path: Path | None = None
    try:
        prefix = f".{target_path.name}."
        if _is_windows():
            source_sd = _get_windows_dacl_sd(source_for_metadata) if source_exists else None
            temp_path, tmp_writer = _open_windows_temp_file(
                target_path.parent, prefix, source_sd
            )
            with tmp_writer as tmp_file:
                json.dump(diagram, tmp_file, indent=2, ensure_ascii=False)
                tmp_file.flush()
                os.fsync(tmp_file.fileno())
        else:
            source_mode = (
                stat.S_IMODE(source_for_metadata.stat().st_mode)
                if source_exists
                else None
            )
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=target_path.parent,
                prefix=prefix,
                suffix=".tmp",
                delete=False,
            ) as tmp_file:
                temp_path = Path(tmp_file.name)
                json.dump(diagram, tmp_file, indent=2, ensure_ascii=False)
                tmp_file.flush()
                os.fsync(tmp_file.fileno())
            if source_mode is not None:
                os.chmod(temp_path, source_mode)
        os.replace(temp_path, target_path)
    except BaseException:
        if temp_path is not None:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise


def create_text_label(text: str, x: float, y: float) -> Dict[str, Any]:
    """
    Create a text label element.
    
    Args:
        text: Label text
        x: X coordinate
        y: Y coordinate
    
    Returns:
        Text element dictionary
    """
    return {
        "id": generate_unique_id(),
        "type": "text",
        "x": x,
        "y": y,
        "width": len(text) * 10,  # Approximate width
        "height": 20,
        "angle": 0,
        "strokeColor": "#1e1e1e",
        "backgroundColor": "transparent",
        "fillStyle": "solid",
        "strokeWidth": 2,
        "strokeStyle": "solid",
        "roughness": 1,
        "opacity": 100,
        "groupIds": [],
        "frameId": None,
        "index": "a0",
        "roundness": None,
        "seed": 1000000000 + hash(text) % 1000000000,
        "version": 1,
        "versionNonce": 2000000000 + hash(text) % 1000000000,
        "isDeleted": False,
        "boundElements": [],
        "updated": 1738195200000,
        "link": None,
        "locked": False,
        "text": text,
        "fontSize": 16,
        "fontFamily": 5,  # Excalifont
        "textAlign": "center",
        "verticalAlign": "top",
        "containerId": None,
        "originalText": text,
        "autoResize": True,
        "lineHeight": 1.25
    }


def add_icon_to_diagram(
    diagram_path: Path,
    icon_name: str,
    x: float,
    y: float,
    library_path: Path,
    label: str | None = None,
    output_path: Path | None = None,
) -> None:
    """
    Add an icon to an Excalidraw diagram.
    
    Args:
        diagram_path: Path to the Excalidraw diagram file to read
        icon_name: Name of the icon to add
        x: Target X coordinate
        y: Target Y coordinate
        library_path: Path to the icon library directory
        label: Optional text label to add below the icon
        output_path: Optional path to write the updated diagram (defaults to diagram_path)
    """
    # Load icon elements
    print(f"Loading icon: {icon_name}")
    icon_elements = load_icon(icon_name, library_path)
    print(f"  Loaded {len(icon_elements)} elements")
    
    # Transform icon elements
    print(f"Transforming to position ({x}, {y})")
    transformed_elements = transform_icon_elements(icon_elements, x, y)
    
    # Calculate icon bounding box for label positioning
    if label and transformed_elements:
        min_x, min_y, max_x, max_y = calculate_bounding_box(transformed_elements)
        icon_width = max_x - min_x
        
        # Position label below icon, centered
        label_x = min_x + (icon_width / 2) - (len(label) * 5)
        label_y = max_y + 10
        
        label_element = create_text_label(label, label_x, label_y)
        transformed_elements.append(label_element)
        print(f"  Added label: '{label}'")
    
    # Resolve symlinks so direct writes update the target file without replacing the symlink
    source_path = diagram_path.resolve()
    print(f"Loading diagram: {diagram_path}")
    with open(source_path, 'r', encoding='utf-8') as f:
        diagram = json.load(f)
    
    # Add transformed elements
    if 'elements' not in diagram:
        diagram['elements'] = []
    
    original_count = len(diagram['elements'])
    diagram['elements'].extend(transformed_elements)
    print(f"  Added {len(transformed_elements)} elements (total: {original_count} -> {len(diagram['elements'])})")
    
    # Save diagram atomically via temporary file so partial writes never corrupt the original
    destination_path = output_path if output_path is not None else source_path
    print("Saving diagram")
    write_diagram_atomic(diagram, destination_path, metadata_source=source_path)
    
    print(f"✓ Successfully added '{icon_name}' icon to diagram")


def main():
    """Main entry point."""
    if hasattr(sys.stdout, "reconfigure"):
        # Ensure consistent UTF-8 output on Windows consoles.
        sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) < 5:
        print("Usage: python add-icon-to-diagram.py <diagram_path> <icon_name> <x> <y> [OPTIONS]")
        print("\nOptions:")
        print("  --library-path PATH    Path to icon library directory")
        print("  --label TEXT           Add text label below icon")
        print("  --use-edit-suffix      Edit via .excalidraw.edit to avoid editor overwrite issues (enabled by default; use --no-use-edit-suffix to disable)")
        print("\nExamples:")
        print("  python add-icon-to-diagram.py diagram.excalidraw EC2 500 300")
        print("  python add-icon-to-diagram.py diagram.excalidraw EC2 500 300 --label 'Web Server'")
        sys.exit(1)
    
    diagram_path = Path(sys.argv[1])
    icon_name = sys.argv[2]
    x = float(sys.argv[3])
    y = float(sys.argv[4])
    
    # Default library path
    script_dir = Path(__file__).parent
    default_library_path = script_dir.parent / "libraries" / "aws-architecture-icons"
    
    # Parse optional arguments
    library_path = default_library_path
    label = None
    # Default: use edit suffix to avoid editor overwrite issues
    use_edit_suffix = True
    
    i = 5
    while i < len(sys.argv):
        if sys.argv[i] == '--library-path':
            if i + 1 < len(sys.argv):
                library_path = Path(sys.argv[i + 1])
                i += 2
            else:
                print("Error: --library-path requires a path argument")
                sys.exit(1)
        elif sys.argv[i] == '--label':
            if i + 1 < len(sys.argv):
                label = sys.argv[i + 1]
                i += 2
            else:
                print("Error: --label requires a text argument")
                sys.exit(1)
        elif sys.argv[i] == '--use-edit-suffix':
            use_edit_suffix = True
            i += 1
        elif sys.argv[i] == '--no-use-edit-suffix':
            use_edit_suffix = False
            i += 1
        else:
            print(f"Error: Unknown option: {sys.argv[i]}")
            sys.exit(1)
    
    # Validate library path before acquiring per-diagram lock
    if not library_path.exists():
        print(f"Error: Library path not found: {library_path}")
        sys.exit(1)
    
    work_path = None
    final_path = None
    staged_path = None
    try:
        with diagram_edit_lock(diagram_path):
            if not diagram_path.exists():
                print(f"Error: Diagram file not found: {diagram_path}")
                sys.exit(1)
            try:
                work_path, final_path = prepare_edit_path(diagram_path, use_edit_suffix)
                if final_path is not None:
                    staged_path = final_path.with_name(
                        f".{final_path.name}.{uuid.uuid4().hex}.staged"
                    )
                    add_icon_to_diagram(
                        work_path, icon_name, x, y, library_path, label, output_path=staged_path
                    )
                    finalize_edit_path(work_path, final_path, staged_path=staged_path)
                else:
                    add_icon_to_diagram(work_path, icon_name, x, y, library_path, label)
                    finalize_edit_path(work_path, final_path)
            except BaseException:
                if staged_path is not None:
                    try:
                        staged_path.unlink(missing_ok=True)
                    except OSError:
                        pass
                if final_path is not None and work_path is not None:
                    restore_edit_path(work_path, final_path)
                raise
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()

