import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/**
 * dex2jar emits calls to static/private interface methods as plain Methodref and in old class
 * file versions, which the JVM rejects. This rewrites them as InterfaceMethodref (Java 8
 * class files) so the converted D8 runs on a regular JVM.
 * With --strip-params it instead drops MethodParameters attributes (JDK 21 javac emits nameless
 * ones that this old D8 cannot read).
 * Usage: java -cp asm.jar tools/D8Fix.java [--strip-params] IN.jar OUT.jar
 */
public class D8Fix {
    public static void main(String[] args) throws Exception {
        boolean stripParams = args[0].equals("--strip-params");
        if (stripParams) args = new String[]{args[1], args[2]};
        Map<String, byte[]> classes = new HashMap<>();
        Map<String, byte[]> other = new HashMap<>();
        Set<String> interfaces = new HashSet<>();
        try (ZipFile zip = new ZipFile(args[0])) {
            Enumeration<? extends ZipEntry> en = zip.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                if (e.isDirectory()) continue;
                byte[] data;
                try (InputStream in = zip.getInputStream(e)) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    in.transferTo(out);
                    data = out.toByteArray();
                }
                if (e.getName().endsWith(".class")) {
                    ClassReader cr = new ClassReader(data);
                    if ((cr.getAccess() & Opcodes.ACC_INTERFACE) != 0) interfaces.add(cr.getClassName());
                    classes.put(e.getName(), data);
                } else {
                    other.put(e.getName(), data);
                }
            }
        }
        int[] fixed = {0};
        try (ZipOutputStream zout = new ZipOutputStream(new FileOutputStream(args[1]))) {
            for (Map.Entry<String, byte[]> c : classes.entrySet()) {
                ClassReader cr = new ClassReader(c.getValue());
                ClassWriter cw = new ClassWriter(0);
                cr.accept(new ClassVisitor(Opcodes.ASM9, cw) {
                    @Override
                    public void visit(int version, int access, String name, String sig, String sup, String[] itfs) {
                        super.visit(stripParams ? version : Math.max(version & 0xFFFF, Opcodes.V1_8),
                                access, name, sig, sup, itfs);
                    }

                    @Override
                    public MethodVisitor visitMethod(int access, String name, String desc, String sig, String[] ex) {
                        return new MethodVisitor(Opcodes.ASM9, super.visitMethod(access, name, desc, sig, ex)) {
                            @Override
                            public void visitParameter(String pName, int pAccess) {
                                if (!stripParams) super.visitParameter(pName, pAccess);
                            }

                            @Override
                            public void visitMethodInsn(int op, String owner, String n, String d, boolean itf) {
                                if (!stripParams && !itf && (op == Opcodes.INVOKESTATIC || op == Opcodes.INVOKESPECIAL)
                                        && isInterface(owner, interfaces)) {
                                    itf = true;
                                    fixed[0]++;
                                }
                                super.visitMethodInsn(op, owner, n, d, itf);
                            }
                        };
                    }
                }, 0);
                zout.putNextEntry(new ZipEntry(c.getKey()));
                zout.write(cw.toByteArray());
                zout.closeEntry();
            }
            for (Map.Entry<String, byte[]> o : other.entrySet()) {
                zout.putNextEntry(new ZipEntry(o.getKey()));
                zout.write(o.getValue());
                zout.closeEntry();
            }
        }
        System.out.println("fixed " + fixed[0] + " interface calls");
    }

    static final Map<String, Boolean> JDK = new HashMap<>();

    static boolean isInterface(String owner, Set<String> local) {
        if (local.contains(owner)) return true;
        return JDK.computeIfAbsent(owner, o -> {
            try {
                return Class.forName(o.replace('/', '.'), false, ClassLoader.getPlatformClassLoader()).isInterface();
            } catch (Throwable t) {
                return false;
            }
        });
    }
}
