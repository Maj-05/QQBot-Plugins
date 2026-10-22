export default {
  name: "pixiv_all_in_one",
  description: "通过接口检索插画。支持根据用户要求返回多张图片，并附带元数据。",
  inputSchema: {
    "type": "object",
    "properties": {
      "tag_or_pid": {
        "type": "string",
        "description": "检索词或纯数字 PID"
      },
      "num": {
        "type": "number",
        "description": "返回图片数量。例如用户说‘发三张’就填3。"
      },
      "safe_mode": {
        "type": "boolean",
        "description": "安全过滤模式。默认为 true（标准模式）。如需无限制模式，请传入 false。"
      }
    },
    "required": ["tag_or_pid"]
  },

  run: async function({ tag_or_pid, num = 1, safe_mode = true }) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    
    let input = tag_or_pid.trim();
    const isUnrestricted = safe_mode === false;
    const r18Param = isUnrestricted ? 1 : 0;

    const fetchWithTimeout = async (url, ms = 5000) => {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), ms);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
            clearTimeout(id);
            return res;
        } catch (e) {
            clearTimeout(id);
            throw e;
        }
    };

    let metaDataList = [];
    let successTag = "";

    // ==========================================
    //  核心优化：判断是否包含 PID 特征
    // ==========================================
    const pidMatch = input.match(/\d{5,}/); 
    
    if (pidMatch) {
        // 走 PID 查询模式
        const cleanPid = pidMatch[0];
        successTag = `PID: ${cleanPid}`;
        
        // 1. 优先尝试用 Lolicon 查 PID (能拿到画师和标题)
        try {
            const url = `https://api.lolicon.app/setu/v2?pid=${cleanPid}&r18=${r18Param}&size=regular`;
            const res = await fetchWithTimeout(url, 5000);
            const data = await res.json();
            if (!data.error && data.data && data.data.length > 0) {
                const item = data.data[0];
                metaDataList.push({
                    url: item.urls.regular,
                    pid: item.pid,
                    author: item.author,
                    title: item.title
                });
            }
        } catch (e) {}

        // 2. 如果 Lolicon 没收录，暴力穷举 pixiv.re 格式兜底
        if (metaDataList.length === 0) {
            const urlsToTry = [
                `https://pixiv.re/${cleanPid}.jpg`,
                `https://pixiv.re/${cleanPid}.png`,
                `https://pixiv.re/${cleanPid}-1.jpg`,
                `https://pixiv.re/${cleanPid}-1.png`
            ];
            for (let url of urlsToTry) {
                try {
                    const res = await fetchWithTimeout(url, 3000);
                    if (res.ok) {
                        metaDataList.push({
                            url: url,
                            pid: cleanPid,
                            author: "未知(图床兜底)",
                            title: "未知(图床兜底)"
                        });
                        break;
                    }
                } catch (e) {}
            }
        }

        if (metaDataList.length === 0) {
            return `[系统提示] 找不到 PID 为 ${cleanPid} 的图片。请直接回复用户“这张图可能被删除了或不存在”。`;
        }

    } 
    // ==========================================
    // 模式二：文字标签搜索
    // ==========================================
    else {
        let coreTag = input;
        if (/^[a-zA-Z\s]+$/.test(coreTag)) {
            coreTag = coreTag.replace(/\s+/g, '_');
        }

        let tagsToTry = [coreTag];
        const lowerTag = coreTag.toLowerCase();
        
        // 特殊角色补全字典
        if (lowerTag.includes('浮士德') || lowerTag.includes('faust')) {
            tagsToTry.push('ファウスト', 'faust_(limbus_company)');
        }

        for (let currentTag of tagsToTry) {
            try {
                const fetchNum = Math.min(Math.max(num + 2, 5), 20);
                const url = `https://api.lolicon.app/setu/v2?tag=${encodeURIComponent(currentTag)}&num=${fetchNum}&r18=${r18Param}&size=regular`;
                const res = await fetchWithTimeout(url, 5000);
                
                if (res.ok) {
                    const data = await res.json();
                    if (!data.error && data.data && data.data.length > 0) {
                        const shuffled = data.data.sort(() => 0.5 - Math.random());
                        shuffled.forEach(item => {
                            metaDataList.push({
                                url: item.urls.regular,
                                pid: item.pid,
                                author: item.author,
                                title: item.title
                            });
                        });
                        successTag = currentTag;
                        break; 
                    }
                }
            } catch (e) {}
        }

        if (metaDataList.length === 0) {
            return `[系统提示] 未找到匹配 "${input}" 的媒体。请直接回复用户“找不到”。`;
        }
    }

    // ==========================================
    // 测速拦截死链
    // ==========================================
    let finalData = [];
    for (let item of metaDataList) {
        try {
            const checkRes = await fetchWithTimeout(item.url, 3000);
            if (checkRes.ok) {
                finalData.push(item);
                if (finalData.length >= num) break;
            }
        } catch (e) {}
    }

    if (finalData.length === 0) {
        return `[系统提示] 找到了 "${input}"，但图床节点抽风(404)，请直接回复用户“图床挂了”。`;
    }

    let imageList = "";
    let metaInfo = "";
    
    finalData.forEach((item, index) => {
        imageList += `图片链接：${item.url}\n`;
        metaInfo += `[图片${index+1}] PID: ${item.pid} | 画师: ${item.author} | 标题: ${item.title}\n`;
    });
    
    return `[系统指令] 检索成功！(使用标签: ${successTag})。
请立即调用内置工具 send_image 依次发送以下图片链接，并在发图后保持沉默，绝对不要输出任何文字。
【注意：请在后台记住以下元数据，如果用户后续问起这些图片的作者或PID，请直接从以下信息中提取回答】
${metaInfo}
${imageList}`;
  }
}
