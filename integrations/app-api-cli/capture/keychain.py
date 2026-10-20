"""macOS Keychain via Security.framework; no secret command-line arguments.

Items are ACL-bound to the managed capture interpreter. Any other interpreter
would block forever on an invisible authorization prompt, so interaction is
disabled and such reads fail fast (-25293/-25308). APP_API_KEYCHAIN_INTERACTIVE=1
restores prompting for a deliberate, attended ACL grant.
"""
import ctypes as C
import json
import os

S = C.CDLL('/System/Library/Frameworks/Security.framework/Security')
F = C.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
S.SecKeychainSetUserInteractionAllowed.argtypes = [C.c_bool]
S.SecKeychainSetUserInteractionAllowed.restype = C.c_int32
S.SecKeychainSetUserInteractionAllowed(os.environ.get('APP_API_KEYCHAIN_INTERACTIVE') == '1')
S.SecKeychainFindGenericPassword.argtypes = [C.c_void_p, C.c_uint32, C.c_char_p, C.c_uint32, C.c_char_p, C.POINTER(C.c_uint32), C.POINTER(C.c_void_p), C.POINTER(C.c_void_p)]
S.SecKeychainFindGenericPassword.restype = C.c_int32
S.SecKeychainAddGenericPassword.argtypes = [C.c_void_p, C.c_uint32, C.c_char_p, C.c_uint32, C.c_char_p, C.c_uint32, C.c_void_p, C.POINTER(C.c_void_p)]
S.SecKeychainAddGenericPassword.restype = C.c_int32
S.SecKeychainItemModifyAttributesAndData.argtypes = [C.c_void_p, C.c_void_p, C.c_uint32, C.c_void_p]
S.SecKeychainItemModifyAttributesAndData.restype = C.c_int32
S.SecKeychainItemFreeContent.argtypes = [C.c_void_p, C.c_void_p]
F.CFRelease.argtypes = [C.c_void_p]
SERVICE = b'app-api-cli.native'

def find(name):
    account = name.encode(); length = C.c_uint32(); data = C.c_void_p(); item = C.c_void_p()
    code = S.SecKeychainFindGenericPassword(None, len(SERVICE), SERVICE, len(account), account, C.byref(length), C.byref(data), C.byref(item))
    return code, length, data, item

def store(name, obj):
    value = json.dumps(obj).encode(); account = name.encode()
    code, length, data, item = find(name)
    if code == 0:
        try: status = S.SecKeychainItemModifyAttributesAndData(item, None, len(value), value)
        finally: S.SecKeychainItemFreeContent(None, data); F.CFRelease(item)
    elif code == -25300:
        status = S.SecKeychainAddGenericPassword(None, len(SERVICE), SERVICE, len(account), account, len(value), value, None)
    else: raise RuntimeError(f'Keychain read status {code}')
    if status: raise RuntimeError(f'Keychain write status {status}')

def load(name):
    code, length, data, item = find(name)
    if code == -25300: return None
    if code: raise RuntimeError(f'Keychain read status {code}')
    try: return json.loads(C.string_at(data, length.value))
    finally: S.SecKeychainItemFreeContent(None, data); F.CFRelease(item)
