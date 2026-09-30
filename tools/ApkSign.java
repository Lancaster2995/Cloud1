import com.android.apksig.ApkSigner;

import java.io.File;
import java.io.FileInputStream;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.Collections;

/**
 * Minimal APK signer (APK Signature Scheme v2; minSdk 29 needs nothing older) used by
 * tools/build-local.sh.
 * Usage: java -cp apksig.jar tools/ApkSign.java KEYSTORE PASSWORD ALIAS IN.apk OUT.apk
 */
public class ApkSign {
    public static void main(String[] args) throws Exception {
        if (args.length != 5) {
            System.err.println("usage: ApkSign KEYSTORE PASSWORD ALIAS IN.apk OUT.apk");
            System.exit(2);
        }
        char[] pass = args[1].toCharArray();
        KeyStore ks = KeyStore.getInstance("PKCS12");
        try (FileInputStream in = new FileInputStream(args[0])) {
            ks.load(in, pass);
        }
        PrivateKey key = (PrivateKey) ks.getKey(args[2], pass);
        X509Certificate cert = (X509Certificate) ks.getCertificate(args[2]);
        ApkSigner.SignerConfig signer = new ApkSigner.SignerConfig.Builder(
                "RELEVO", key, Collections.singletonList(cert)).build();
        new ApkSigner.Builder(Collections.singletonList(signer))
                .setInputApk(new File(args[3]))
                .setOutputApk(new File(args[4]))
                .setMinSdkVersion(29)
                .setV1SigningEnabled(false)
                .setV2SigningEnabled(true)
                .setCreatedBy("Relevo build-local")
                .build()
                .sign();
        System.out.println("signed " + args[4]);
    }
}
