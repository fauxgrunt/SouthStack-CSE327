# Faculty Quick Start: "Build This" UI Generator

## For Faculty: Zero-to-Code in 3 Steps

### Step 1: Screenshot the UI You Want

Take a screenshot or capture an image of:

- A login page
- A form
- A dashboard screen
- Any UI design you want replicated

_Example_: NSU Portal login screen

### Step 2: Upload the Image

In the SouthStack IDE:

1. Click the **camera icon** in the input area
2. Select your screenshot file
3. Wait for it to load (you'll see the image preview)

### Step 3: Type "Build This"

In the text input box, type ONE of:

- **"build this"** ← Most common
- "create this"
- "build it"
- "generate this"
- "create it"
- "make this"
- "replicate this"
- Or any similar simple request

Then press **Send** or hit **Enter**.

---

## What Happens Next

### Automatic Detection 🎯

The system detects your "build this" request and:

1. ✅ Analyzes the image with AI Vision
2. ✅ Extracts exact text with OCR
3. ✅ Generates React code
4. ✅ Shows preview in real-time

### Status Messages

You'll see:

```
Faculty: "build this"

System: 🎯 Auto-detected 'build this' request with image attachment.
        Skipping task decomposition and going directly to code generation...

[Worker is generating code...]

[Code generated! Preview updating...]
```

**Typical time**: 35-45 seconds

---

## Real Examples

### Example 1: Login Form

**Screenshot**: NSU Portal login screen with username field, Next button
**You type**: "build this"
**Result**: ✅ Perfect React login component with Tailwind styling

### Example 2: Dashboard Card

**Screenshot**: Analytics dashboard with charts and stats
**You type**: "build it"
**Result**: ✅ React dashboard with matching layout and colors

### Example 3: Sign-Up Form

**Screenshot**: Registration form with multiple fields
**You type**: "generate this"
**Result**: ✅ Fully functional React form component

---

## Tips for Best Results

### ✅ Do This

- Use **clear, well-lit screenshots** of UI
- Include the **full page/screen** in the screenshot
- Use a simple prompt like **"build this"**
- Make sure the **image quality is good** (not blurry)

### ❌ Don't Do This

- Don't use blurry or low-resolution images
- Don't include multiple unrelated UIs in one screenshot
- Don't use complex prompts (e.g., "build a login form with validation...")
- Don't include personal data or sensitive information

---

## What Code Do You Get?

The system generates:

- ✅ **React component** with hooks (useState)
- ✅ **Tailwind CSS** styling
- ✅ **Responsive layout** matching the screenshot
- ✅ **Exact colors, spacing, typography**
- ✅ **All visible text** from the screenshot
- ✅ **Modern, polished design**

Example output:

```jsx
export default function App() {
  return (
    <div className="min-h-screen bg-gradient-to-r from-blue-500 to-cyan-400 flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-lg p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold text-yellow-500 mb-6">
          NSU Portal : Login
        </h1>
        <label className="block text-white mb-2">Username</label>
        <input
          type="text"
          placeholder="Please enter your username"
          className="w-full px-4 py-2 rounded border border-gray-300 mb-4"
        />
        <button className="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-2 px-4 rounded">
          Next
        </button>
        {/* ...rest of component */}
      </div>
    </div>
  );
}
```

---

## Troubleshooting

### Problem: Nothing happens when I click Send

**Solution**:

- Make sure image is attached (you should see a thumbnail)
- Make sure you typed your prompt
- Make sure the system is ready (green "Agent idle" status)

### Problem: Code looks incomplete

**Solution**:

- The system may need a moment to render. Wait 5 seconds.
- Click the **"Preview"** tab to see the generated UI
- If still incomplete, try again with a clearer screenshot

### Problem: Colors don't match

**Solution**:

- The AI tries to detect colors from your screenshot
- If needed, you can edit the React code directly in the Code tab
- Change Tailwind classes to adjust colors

### Problem: Text is different from my screenshot

**Solution**:

- The OCR extracts exact text from the image
- If OCR misread something, manually edit the React code
- Look for the OCR section in the generation logs

---

## Advanced: Combining Multiple Requests

### Refinement Loop (Coming Soon)

```
Faculty: [Upload login screen image]
Faculty: "build this"
System: [Generates login code]

Faculty: "make the button red"
System: [Updates only the button styling]

Faculty: "change the title color to purple"
System: [Updates the title]
```

---

## For Technical Details

See the following documentation:

- [Detailed Setup Guide](BUILD_THIS_AUTO_DETECT.md)
- [Implementation Details](IMPLEMENTATION_SUMMARY.md)
- [Dual-Extraction Pipeline](REAL_IMPLEMENTATION.md)

---

## Quick Reference: Recognized Prompts

| Phrase                       | Works?               |
| ---------------------------- | -------------------- |
| "build this"                 | ✅ Yes               |
| "build it"                   | ✅ Yes               |
| "build"                      | ✅ Yes               |
| "create this"                | ✅ Yes               |
| "generate this"              | ✅ Yes               |
| "make this"                  | ✅ Yes               |
| "implement this"             | ✅ Yes               |
| "code this"                  | ✅ Yes               |
| "convert to react"           | ✅ Yes               |
| "replicate this"             | ✅ Yes               |
| "recreate this"              | ✅ Yes               |
| "build a login form with..." | ❌ No (too specific) |
| "create a dashboard"         | ❌ No (too specific) |

The system works best with **simple, direct requests**. For complex instructions, use normal prompts.

---

## Still Have Questions?

Contact: SouthStack Support  
Email: support@southstack.edu  
Docs: [BUILD_THIS_AUTO_DETECT.md](BUILD_THIS_AUTO_DETECT.md)
