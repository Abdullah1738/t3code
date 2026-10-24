"""mailsend against a fake himalaya and a fake send-approval. Nothing is sent."""
import json
import os
import subprocess
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "..", "helpers", "mailsend")

# Builds the MIME the way himalaya compose/reply/forward print it; logs every call.
FAKE_HIMALAYA = r'''
import json, os, sys, time
from email.message import EmailMessage
argv = sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as fh:
    fh.write(json.dumps(argv) + "\n")
acct = argv[argv.index("-a") + 1]
verb = argv[argv.index("message") + 1]
if verb == "send":
    if os.environ.get("FAKE_SEND_SLEEP"):
        time.sleep(float(os.environ["FAKE_SEND_SLEEP"]))
    rc = int(os.environ.get("FAKE_SEND_RC") or 0)
    if rc:
        print("smtp error: 554 rejected", file=sys.stderr)
    sys.exit(rc)
if verb == "add":
    sys.exit(int(os.environ.get("FAKE_ADD_RC") or 0))
def opt(name):
    return [a.split("=", 1)[1] for a in argv if a.startswith(name + "=")]
m = EmailMessage()
m["From"] = '"Abdullah Rangoonwala" <%s@example.com>' % acct
to = opt("--to")
if verb == "reply":
    to = ["orig@example.com"] + to
if to:
    m["To"] = ", ".join("<%s>" % t for t in to)
if opt("--cc"):
    m["Cc"] = ", ".join("<%s>" % t for t in opt("--cc"))
if os.environ.get("FAKE_BCC"):
    m["Bcc"] = "<hidden@example.com>"
m["Subject"] = {"compose": (opt("--subject") or [""])[0], "reply": "Re: Hi", "forward": "Fwd: Hi"}[verb]
body = (opt("--body") or [""])[0]
if verb in ("reply", "forward"):
    # himalaya quotes the source message and adds the account signature.
    body += "\n\n> the original secret line\n-- \nAbdullah's signature"
m.set_content(body)
if os.environ.get("FAKE_HTML"):
    m.add_alternative("<p>%s</p>" % body, subtype="html")
for p in opt("--attach"):
    if os.environ.get("FAKE_DROP_ATTACH"):
        continue
    with open(p, "rb") as fh:
        m.add_attachment(fh.read(), maintype="application", subtype="octet-stream", filename=os.path.basename(p))
sys.stdout.buffer.write(bytes(m))
'''

FAKE_APPROVAL = """#!/usr/bin/python3
import json, os, sys, time
if sys.argv[1] == "visible":
    sys.exit("Refused: hidden text" if "<think" in sys.argv[2] else 0)
with open(os.environ["FAKE_APPROVALS"], "a") as fh:
    fh.write(json.dumps(sys.argv[1:]) + "\\n")
time.sleep(float(os.environ.get("SA_SLEEP") or 0))
if os.environ.get("SA_REFUSE"):
    sys.exit("Refused: not shown")
print("approved: ok")
"""


def read_json(path):
    with open(path) as fh:
        return json.load(fh)


class MailsendTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.tmp.name
        self.drafts = os.path.join(t, "drafts")
        self.log = os.path.join(t, "himalaya.log")
        self.approvals = os.path.join(t, "approvals.log")
        fake = os.path.join(t, "fake_himalaya.py")
        with open(fake, "w") as fh:
            fh.write(FAKE_HIMALAYA)
        sa = os.path.join(t, "send-approval")
        with open(sa, "w") as fh:
            fh.write(FAKE_APPROVAL)
        os.chmod(sa, 0o755)
        self.file = os.path.join(t, "menu.pdf")
        with open(self.file, "wb") as fh:
            fh.write(b"%PDF fake")
        self.env = {"HOME": t, "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8", "MAILSEND_DRAFT_DIR": self.drafts,
                    "MAILSEND_HIMALAYA": f"/usr/bin/python3 {fake}", "MAILSEND_SEND_APPROVAL": sa,
                    "FAKE_LOG": self.log, "FAKE_APPROVALS": self.approvals}

    def tearDown(self):
        self.tmp.cleanup()

    def ms(self, *args, **extra):
        r = subprocess.run(["/usr/bin/python3", HELPER, *args], env={**self.env, **extra}, capture_output=True,
                           text=True, timeout=60)
        return r.returncode, r.stdout, r.stderr

    def calls(self, verb=None):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as fh:
            rows = [json.loads(l) for l in fh if l.strip()]
        return [r for r in rows if verb is None or r[r.index("message") + 1] == verb]

    def approval_calls(self):
        if not os.path.exists(self.approvals):
            return []
        with open(self.approvals) as fh:
            return [json.loads(l) for l in fh if l.strip()]

    def draft(self, *extra, body="Can we move it to Friday?"):
        code, out, err = self.ms("draft", "-a", "icloud", "-t", "host@example.com", "-s", "Booking",
                                 "--body", body, *extra)
        self.assertEqual(code, 0, err)
        return out.split()[1], out

    def state(self, i):
        return sorted(f for f in os.listdir(self.drafts) if f.startswith(i))

    def test_draft_prints_the_preview_and_sends_nothing(self):
        i, out = self.draft("--cc", "moni@example.com", "--attach", self.file)
        self.assertRegex(i, r"^[0-9a-f]{10}$")
        d = read_json(os.path.join(self.drafts, f"{i}.json"))
        self.assertEqual(d["preview"], "Email from icloud@example.com (icloud)\nTo: host@example.com\n"
                         f"Cc: moni@example.com\nSubject: Booking\nAttachment: {self.file} (sha256 "
                         f"{d['attachments'][0]['sha256'][:12]})\n\nCan we move it to Friday?\n(draft {i})")
        self.assertIn(d["preview"], out)
        self.assertIn(f"After his OK: mailsend send --approved {i} --inbound <incoming message ID of his reply>", out)
        self.assertEqual(self.calls("send"), [])
        compose = self.calls("compose")[0]
        self.assertNotIn("--send", compose)
        self.assertNotIn("--save", " ".join(compose))
        self.assertEqual((d["from"], d["to"], d["cc"], d["subject"]),
                         ("icloud@example.com", ["host@example.com"], ["moni@example.com"], "Booking"))
        self.assertEqual(len(d["attachments"]), 1)

    def test_send_needs_his_reply_not_just_the_id(self):
        i, _ = self.draft()
        for extra in ([], ["--inbound", ""]):
            code, _, err = self.ms("send", "--approved", i, *extra)
            self.assertEqual(code, 2)
            self.assertIn("alone isn't Abdullah's OK", err)
        self.assertEqual(self.approval_calls(), [])
        self.assertEqual(self.calls("send"), [])

    def test_approved_send_goes_once_and_binds_every_field(self):
        i, _ = self.draft("--cc", "moni@example.com", "--attach", self.file)
        code, out, err = self.ms("send", "--approved", i, "--inbound", "6E3E6964-AAAA")
        self.assertEqual(code, 0, err)
        self.assertIn("(sent) Email to host@example.com, moni@example.com: Booking", out)
        a = self.approval_calls()[0]
        d = read_json(os.path.join(self.drafts, f"{i}.sent.json"))
        sha = d["attachments"][0]["sha256"]
        self.assertEqual(a, ["check", "--inbound", "6E3E6964-AAAA", "--preview", d["preview"], "--drafted-at",
                             str(d["created_at"]), "--file", sha, "menu.pdf"])
        sends = self.calls("send")
        self.assertEqual(len(sends), 1)
        self.assertEqual(sends[0][-1], os.path.join(self.drafts, f"{i}.eml"))
        self.assertEqual(self.calls("add")[0][:7], ["-a", "icloud", "message", "add", "-m", "sent", "-f"])
        self.assertEqual(self.state(i), [f"{i}.eml", f"{i}.sent.json"])
        code, _, err = self.ms("send", "--approved", i, "--inbound", "6E3E6964-AAAA")
        self.assertEqual(code, 2)
        self.assertIn("already used", err)
        self.assertEqual(len(self.calls("send")), 1)
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "host@example.com", "-s", "Booking",
                               "--body", "Can we move it to Friday?", "--cc", "moni@example.com",
                               "--attach", self.file)
        self.assertEqual(code, 2)
        self.assertIn("already sent", err)

    def test_google_accounts_get_no_extra_sent_copy(self):
        code, out, err = self.ms("draft", "-a", "fund", "-t", "host@example.com", "-s", "Hi", "--body", "Hello")
        i = out.split()[1]
        self.assertEqual(self.ms("send", "--approved", i, "--app")[0], 0)
        self.assertEqual(self.approval_calls()[0][:2], ["check", "--app"])
        self.assertEqual(len(self.calls("send")), 1)
        self.assertEqual(self.calls("add"), [])

    def test_refused_approval_keeps_the_draft_pending(self):
        i, _ = self.draft()
        code, _, err = self.ms("send", "--approved", i, "--inbound", "X1", SA_REFUSE="1")
        self.assertEqual(code, 2)
        self.assertIn("Refused: not shown", err)
        self.assertEqual(self.calls("send"), [])
        self.assertEqual(self.state(i), [f"{i}.eml", f"{i}.json"])
        self.assertEqual(self.ms("send", "--approved", i, "--inbound", "X2")[0], 0)

    def test_a_revision_is_a_new_draft(self):
        a, _ = self.draft(body="Can we do EUR 3500?")
        b, _ = self.draft(body="Can we do EUR 3400?")
        self.assertNotEqual(a, b)

    def test_changed_attachment_or_stored_message_is_refused(self):
        i, _ = self.draft("--attach", self.file)
        with open(self.file, "ab") as fh:
            fh.write(b"edited")
        code, _, err = self.ms("send", "--approved", i, "--inbound", "X1")
        self.assertEqual(code, 2)
        self.assertIn("changed or is gone", err)
        j, _ = self.draft(body="other text")
        with open(os.path.join(self.drafts, f"{j}.eml"), "ab") as fh:
            fh.write(b"\nBcc: sneaky@example.com\n")
        code, _, err = self.ms("send", "--approved", j, "--inbound", "X1")
        self.assertEqual(code, 2)
        self.assertIn("changed", err)
        self.assertEqual(self.approval_calls(), [])
        self.assertEqual(self.calls("send"), [])

    def test_expired_and_unknown_drafts_are_refused(self):
        i, _ = self.draft()
        p = os.path.join(self.drafts, f"{i}.json")
        d = read_json(p)
        d["created_at"] = int(time.time()) - 2 * 86400
        with open(p, "w") as fh:
            json.dump(d, fh)
        code, _, err = self.ms("send", "--approved", i, "--inbound", "X1")
        self.assertEqual(code, 2)
        self.assertIn("older than 24h", err)
        code, _, err = self.ms("send", "--approved", "0123456789", "--inbound", "X1")
        self.assertEqual(code, 2)
        self.assertIn("no draft", err)
        self.assertEqual(self.calls("send"), [])

    def test_no_bcc_and_plain_addresses_only(self):
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "a@example.com", "--bcc", "b@example.com", "-s", "x",
                               "--body", "y")
        self.assertEqual(code, 2)
        self.assertIn("no Bcc", err)
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "Bee <b@example.com>", "-s", "x", "--body", "y")
        self.assertEqual(code, 2)
        self.assertIn("plain address", err)
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "a@example.com", "-s", "x", "--body", "y",
                               FAKE_BCC="1")
        self.assertEqual(code, 2)
        self.assertIn("Bcc header", err)
        self.assertFalse(os.path.exists(self.drafts) and os.listdir(self.drafts))

    def test_text_the_chat_would_hide_is_refused_at_draft_time(self):
        # Sol r2: the bridge strips internal and DCP text, so a preview with any isn't what he reads.
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "a@example.com", "-s", "x",
                               "--body", "Price is EUR 400 <think>say 500</think>")
        self.assertEqual(code, 2)
        self.assertIn("hidden text", err)
        self.assertFalse(os.path.exists(self.drafts) and [f for f in os.listdir(self.drafts) if f.endswith(".json")])

    def test_dropped_attachment_is_caught_at_draft_time(self):
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "a@example.com", "-s", "x", "--body", "y",
                               "--attach", self.file, FAKE_DROP_ATTACH="1")
        self.assertEqual(code, 1)
        self.assertIn("attachments don't match", err)

    def test_reply_and_forward_build_from_the_source_message(self):
        code, out, err = self.ms("reply", "-a", "gmail", "-m", "Inbox", "262282", "--body", "Thanks!")
        self.assertEqual(code, 0, err)
        self.assertIn("To: orig@example.com\nSubject: Re: Hi", out)
        # The preview is the whole text that goes out, quoted original and signature included.
        self.assertIn("Thanks!\n\n> the original secret line\n-- \nAbdullah's signature\n(draft ", out)
        r = self.calls("reply")[0]
        self.assertEqual(r[-2:], ["--", "262282"])
        self.assertIn("-m", r)
        code, out, err = self.ms("forward", "-a", "gmail", "-m", "Inbox", "262282", "-t", "b@example.com")
        self.assertEqual(code, 0, err)
        self.assertIn("To: b@example.com\nSubject: Fwd: Hi", out)

    def test_failed_send_is_settled_and_not_retried(self):
        i, _ = self.draft()
        code, _, err = self.ms("send", "--approved", i, "--inbound", "X1", FAKE_SEND_RC="1")
        self.assertEqual(code, 1)
        self.assertIn("554", err)
        self.assertEqual(self.state(i), [f"{i}.eml", f"{i}.failed.json"])
        self.assertEqual(self.ms("send", "--approved", i, "--inbound", "X1")[0], 2)
        self.assertEqual(len(self.calls("send")), 1)
        # Writing it again gives a new id and preview, so the old OK can't send it.
        j, out = self.draft()
        self.assertNotEqual(i, j)
        self.assertIn(f"(draft {j})", out)

    def test_only_plain_text_mail(self):
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "a@example.com", "-s", "x", "--body", "y",
                               FAKE_HTML="1")
        self.assertEqual(code, 1)
        self.assertIn("plain text only", err)

    def test_a_pending_draft_is_never_rebuilt(self):
        i, _ = self.draft()
        eml = os.path.join(self.drafts, f"{i}.eml")
        with open(eml, "rb") as fh:
            before = fh.read()
        j, out = self.draft()
        self.assertEqual(i, j)
        with open(eml, "rb") as fh:
            self.assertEqual(fh.read(), before)

    def test_an_expired_draft_built_again_gets_a_new_id(self):
        # Astra r1 B5: a redraft of an expired WhatsApp draft renewed its clock under the same id; same for mail.
        i, _ = self.draft()
        p = os.path.join(self.drafts, f"{i}.json")
        d = read_json(p)
        d["created_at"] = int(time.time()) - 3 * 86400
        with open(p, "w") as fh:
            json.dump(d, fh)
        j, out = self.draft()
        self.assertNotEqual(i, j)
        self.assertIn(f"(draft {j})", out)
        self.assertTrue(os.path.exists(os.path.join(self.drafts, f"{i}.expired.json")))
        code, _, err = self.ms("send", "--approved", i, "--inbound", "X1")
        self.assertEqual(code, 2)
        self.assertIn("already used (expired)", err)
        self.assertEqual(self.approval_calls(), [])
        # A fresh pending draft keeps its clock when built again.
        pj = os.path.join(self.drafts, f"{j}.json")
        d = read_json(pj)
        d["created_at"] -= 3600
        with open(pj, "w") as fh:
            json.dump(d, fh)
        k, _ = self.draft()
        self.assertEqual(k, j)
        self.assertEqual(read_json(pj)["created_at"], d["created_at"])

    def test_an_id_retired_while_waiting_for_its_lock_is_not_reused(self):
        # Astra r2 S1: the failed/expired check ran before the lock, so a builder waiting on it published the id
        # another process had just retired, and its send was refused as already used.
        import fcntl
        i, _ = self.draft()
        for f in (f"{i}.json", f"{i}.eml"):
            os.remove(os.path.join(self.drafts, f))
        with open(os.path.join(self.drafts, "locks", i), "a") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            b = subprocess.Popen(["/usr/bin/python3", HELPER, "draft", "-a", "icloud", "-t", "host@example.com", "-s",
                                  "Booking", "--body", "Can we move it to Friday?"], env=self.env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            time.sleep(3)  # b is past its first check and waiting for the lock
            with open(os.path.join(self.drafts, f"{i}.failed.json"), "w") as fh:
                fh.write("{}")
        out, err = b.communicate(timeout=60)
        self.assertEqual(b.returncode, 0, err)
        j = out.split()[1]
        self.assertNotEqual(j, i)
        self.assertFalse(os.path.exists(os.path.join(self.drafts, f"{i}.json")))

    def test_two_senders_at_once_send_once(self):
        # Sol r1: a second sender could rename over the claim and send again.
        i, _ = self.draft()
        cmd = ["/usr/bin/python3", HELPER, "send", "--approved", i, "--inbound", "X1"]
        env = {**self.env, "SA_SLEEP": "1"}
        procs = [subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(3)]
        codes = sorted(p.communicate(timeout=60) and p.returncode for p in procs)
        self.assertEqual(codes, [0, 2, 2])
        self.assertEqual(len(self.calls("send")), 1)
        self.assertEqual(self.state(i), [f"{i}.eml", f"{i}.sent.json"])

    def test_timed_out_send_is_uncertain_and_blocks_a_redraft(self):
        i, _ = self.draft()
        code, _, err = self.ms("send", "--approved", i, "--inbound", "X1", FAKE_SEND_SLEEP="5",
                               MAILSEND_SEND_TIMEOUT="1")
        self.assertEqual(code, 1)
        self.assertIn("may or may not have gone out", err)
        self.assertEqual(self.state(i), [f"{i}.eml", f"{i}.uncertain.json"])
        code, _, err = self.ms("draft", "-a", "icloud", "-t", "host@example.com", "-s", "Booking",
                               "--body", "Can we move it to Friday?")
        self.assertEqual(code, 2)
        self.assertIn("already sent or attempted", err)

    def test_failed_sent_copy_is_only_a_warning(self):
        i, _ = self.draft()
        code, out, err = self.ms("send", "--approved", i, "--inbound", "X1", FAKE_ADD_RC="1")
        self.assertEqual(code, 0)
        self.assertIn("(sent)", out)
        self.assertIn("don't resend", err)
        self.assertEqual(self.state(i), [f"{i}.eml", f"{i}.sent.json"])


if __name__ == "__main__":
    unittest.main()
