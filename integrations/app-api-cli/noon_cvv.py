"""Native encryptDataV2 CVV envelope; plaintext and encrypted values stay in RAM."""
import base64
import re

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa


class CvvError(RuntimeError):
    pass


def encrypt(config, cvv):
    """RSA-OAEP SHA256/MGF1-SHA256, UTF-8 digits, standard Base64.

    Native f29190 passes {key,oaepHash:'sha256',padding:RSA_PKCS1_OAEP_PADDING}
    to publicEncrypt and calls toString('base64'). No label is supplied. The
    caller's string CVV is not JSON quoted. This performs no payment or storage.
    """
    try:
        if type(cvv) not in (bytes, bytearray) or re.fullmatch(rb'[0-9]{3,4}', cvv) is None:
            raise CvvError('CVV_INPUT_INVALID')
        if type(config) is not dict or type(config.get('cvv_encryption')) is not dict:
            raise CvvError('CVV_CONFIG_REQUIRED')
        encryption=config['cvv_encryption']
        pem,name=encryption.get('public_key'),encryption.get('public_key_name')
        if (type(pem) is not str or not 64 <= len(pem) <= 16000
                or type(name) is not str or re.fullmatch(r'[A-Za-z0-9_.:-]{1,200}',name) is None):
            raise CvvError('CVV_CONFIG_INVALID')
        key=serialization.load_pem_public_key(pem.encode('ascii'))
        if not isinstance(key,rsa.RSAPublicKey) or not 2048 <= key.key_size <= 8192:
            raise CvvError('CVV_PUBLIC_KEY_UNSUPPORTED')
        ciphertext=key.encrypt(bytes(cvv),padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),
                                                    algorithm=hashes.SHA256(),label=None))
        return {'encCvv':base64.b64encode(ciphertext).decode('ascii'),'publicKeyName':name}
    except CvvError:
        raise
    except Exception:
        raise CvvError('CVV_ENCRYPTION_FAILED') from None
