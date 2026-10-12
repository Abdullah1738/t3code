import base64
import json
import subprocess
import unittest

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa, ec
import noon_cvv as cvv


class EncryptionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        cls.pem=cls.key.public_key().public_bytes(serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo).decode()

    def config(self):
        return {'cvv_encryption':{'public_key':self.pem,'public_key_name':'synthetic-key-1'}}

    def test_encrypts_digits_without_json_quotes_and_randomizes(self):
        one=cvv.encrypt(self.config(),b'007');two=cvv.encrypt(self.config(),b'007')
        self.assertNotEqual(one['encCvv'],two['encCvv'])
        raw=base64.b64decode(one['encCvv'],validate=True)
        self.assertEqual(len(raw),256)
        self.assertEqual(self.key.decrypt(raw,padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),
            algorithm=hashes.SHA256(),label=None)),b'007')
        self.assertEqual(one['publicKeyName'],'synthetic-key-1')

    def test_node_native_public_encrypt_parameters_interoperate(self):
        private=self.key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode()
        encrypted=cvv.encrypt(self.config(),b'007')
        # Synthetic key/CVV only, piped in memory. Node is the native API shape.
        js="""const c=require('node:crypto');let s='';process.stdin.on('data',x=>s+=x);
process.stdin.on('end',()=>{const x=JSON.parse(s);const plain=c.privateDecrypt({key:x.key,
oaepHash:'sha256',padding:c.constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(x.cipher,'base64'));
process.stdout.write(JSON.stringify({plain:plain.toString('utf8'),roundtrip:c.publicEncrypt({key:x.public,
oaepHash:'sha256',padding:c.constants.RSA_PKCS1_OAEP_PADDING},Buffer.from('007')).toString('base64')}));});"""
        result=subprocess.run(['node','-e',js],input=json.dumps({'key':private,'public':self.pem,
            'cipher':encrypted['encCvv']}),text=True,capture_output=True,timeout=10,check=True)
        value=json.loads(result.stdout);self.assertEqual(value['plain'],'007')
        raw=base64.b64decode(value['roundtrip'])
        self.assertEqual(self.key.decrypt(raw,padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),
            algorithm=hashes.SHA256(),label=None)),b'007')

    def test_bad_input_and_non_rsa_key_fail_without_echo(self):
        for value in (b'',b'12',b'12345',b'abc','007',None,b'007\n'):
            with self.assertRaisesRegex(cvv.CvvError,'CVV_INPUT_INVALID'):
                cvv.encrypt(self.config(),value)
        config=self.config()
        config['cvv_encryption']['public_key']=ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(
            serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        with self.assertRaisesRegex(cvv.CvvError,'PUBLIC_KEY_UNSUPPORTED'):cvv.encrypt(config,b'007')
        config['cvv_encryption']['public_key']='private-marker'*20
        with self.assertRaisesRegex(cvv.CvvError,'CVV_ENCRYPTION_FAILED'):cvv.encrypt(config,b'007')


if __name__=='__main__':unittest.main()
