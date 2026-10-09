// URL格式化
const formatURL = (props: any, v: any, key?: string) => {
  const ERROR_MSG = `${v._vh_filename || ''} 上传失败`;
  // 服务端已返回完整直链（/v2/ 代理），直接使用
  const LINK = v?.data?.link;
  if (!LINK) return ERROR_MSG;
  return key == 'md' ? `![${v._vh_filename || LINK}](${LINK})` : LINK;
};

export { formatURL };
