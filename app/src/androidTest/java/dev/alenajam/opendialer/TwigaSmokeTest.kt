package dev.alenajam.opendialer

import android.content.pm.PackageManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.alenajam.opendialer.ui.ReceptionistActivity
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TwigaSmokeTest {
    @Test
    fun receptionistWorkspaceLaunches() {
        ActivityScenario.launch(ReceptionistActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val content = activity.findViewById<android.view.ViewGroup>(android.R.id.content)
                assertNotNull("Activity content root must exist", content)
                assertTrue("Compose UI must attach to the activity", content.childCount > 0)
            }
        }
    }

    @Test
    fun packageDeclaresCoreTelephonyAndNetworkPermissions() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val info = context.packageManager.getPackageInfo(
            context.packageName,
            PackageManager.GET_PERMISSIONS
        )
        val permissions = info.requestedPermissions?.toSet().orEmpty()
        assertTrue(permissions.contains(android.Manifest.permission.INTERNET))
        assertTrue(permissions.contains(android.Manifest.permission.CALL_PHONE))
        assertTrue(permissions.contains(android.Manifest.permission.READ_PHONE_STATE))
        assertTrue(permissions.contains(android.Manifest.permission.ANSWER_PHONE_CALLS))
        assertTrue(permissions.contains(android.Manifest.permission.RECORD_AUDIO))
    }

    @Test
    fun launcherIntentIsResolvable() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertNotNull(context.packageManager.getLaunchIntentForPackage(context.packageName))
    }
}
